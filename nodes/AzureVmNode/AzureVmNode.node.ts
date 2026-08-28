import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { azureApiRequest, azureApiRequestAllItems, waitForAzureOperation } from './GenericFunctions';
import type { FilterGroup, FilterRow } from './VmFilter';
import { extractPowerState, vmMatchesFilters } from './VmFilter';

const COMPUTE_API_VERSION = '2024-07-01';
const TAGS_API_VERSION = '2021-04-01';

// Maps the node's "Operation" value to the Azure Compute action verb used in
// the REST path: POST .../virtualMachines/{name}/{action}
const POWER_ACTIONS: { [key: string]: string } = {
	start: 'start',
	stop: 'powerOff',
	deallocate: 'deallocate',
};

// Azure only returns the subscription ID and resource group name buried inside
// the resource `id` (/subscriptions/{sub}/resourceGroups/{rg}/providers/...).
// Surface both as top-level output fields so downstream nodes don't have to
// string-parse `id` themselves. Segment casing in Azure-returned IDs varies,
// so match case-insensitively.
function addResourceIds(vm: IDataObject): void {
	const id = (vm.id as string) ?? '';
	vm.subscriptionId = id.match(/\/subscriptions\/([^/]+)/i)?.[1] ?? null;
	vm.resourceGroup = id.match(/\/resourceGroups\/([^/]+)/i)?.[1] ?? null;
}

export class AzureVmNode implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Azure VM Operations',
		name: 'azureVmNode',
		icon: 'file:azureVm.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'List, monitor, and manage the power state and tags of Azure Virtual Machines',
		usableAsTool: true,
		defaults: {
			name: 'Azure VM',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'azureVmApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'list',
				options: [
					{
						name: 'Deallocate',
						value: 'deallocate',
						description: 'Stop a VM and release its compute resources (no compute billing)',
						action: 'Deallocate a VM',
					},
					{
						name: 'Get Status',
						value: 'getStatus',
						description: 'Get the current power/provisioning status and properties of a VM',
						action: 'Get VM status',
					},
					{
						name: 'List VMs',
						value: 'list',
						description: 'List Virtual Machines in a subscription or resource group',
						action: 'List virtual machines',
					},
					{
						name: 'Manage Tags',
						value: 'manageTags',
						description: 'Add/update, remove, or replace tags on a VM',
						action: 'Manage VM tags',
					},
					{
						name: 'Start',
						value: 'start',
						description: 'Start a stopped or deallocated VM',
						action: 'Start a VM',
					},
					{
						name: 'Stop',
						value: 'stop',
						description: 'Power off a VM (compute resources stay allocated and billed)',
						action: 'Stop a VM',
					},
				],
			},

			// ------------------------------------------------------------------
			// List VMs — subscription(s) and, optionally, resource group(s),
			// all fetched from Azure and multi-selectable so the operation can
			// fan out across several subscriptions/resource groups at once.
			// ------------------------------------------------------------------
			{
				displayName: 'Subscription Names or IDs',
				name: 'subscriptionIds',
				type: 'multiOptions',
				default: [],
				required: true,
				typeOptions: { loadOptionsMethod: 'getSubscriptions' },
				displayOptions: { show: { operation: ['list'] } },
				description: 'Azure Subscription(s) to list VMs in. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Scope',
				name: 'scope',
				type: 'options',
				default: 'subscription',
				displayOptions: { show: { operation: ['list'] } },
				options: [
					{ name: 'Entire Subscription(s)', value: 'subscription' },
					{ name: 'Specific Resource Group(s)', value: 'resourceGroup' },
				],
				description:
					'Whether to list every VM in the selected subscription(s), or only those in specific resource groups',
			},
			{
				displayName: 'Resource Group Names or IDs',
				name: 'resourceGroups',
				type: 'multiOptions',
				default: [],
				required: true,
				typeOptions: {
					loadOptionsMethod: 'getResourceGroupsForList',
					loadOptionsDependsOn: ['subscriptionIds'],
				},
				displayOptions: { show: { operation: ['list'], scope: ['resourceGroup'] } },
				description: 'Resource Group(s) to list VMs in. Select Subscription(s) above first. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},

			// ------------------------------------------------------------------
			// Single-VM operations — a specific VM lives in exactly one
			// subscription/resource group, so these stay single-select and each
			// dropdown depends on the one before it.
			// ------------------------------------------------------------------
			{
				displayName: 'Subscription Name or ID',
				name: 'subscriptionId',
				type: 'options',
				default: '',
				required: true,
				typeOptions: { loadOptionsMethod: 'getSubscriptions' },
				displayOptions: {
					show: { operation: ['getStatus', 'start', 'stop', 'deallocate', 'manageTags'] },
				},
				description: 'The Azure Subscription the VM belongs to. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Resource Group Name or ID',
				name: 'resourceGroup',
				type: 'options',
				default: '',
				required: true,
				typeOptions: {
					loadOptionsMethod: 'getResourceGroups',
					loadOptionsDependsOn: ['subscriptionId'],
				},
				displayOptions: {
					show: { operation: ['getStatus', 'start', 'stop', 'deallocate', 'manageTags'] },
				},
				description: 'Name of the Resource Group the VM belongs to. Select a Subscription above first. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'VM Name or ID',
				name: 'vmName',
				type: 'options',
				default: '',
				required: true,
				typeOptions: {
					loadOptionsMethod: 'getVirtualMachines',
					loadOptionsDependsOn: ['subscriptionId', 'resourceGroup'],
				},
				displayOptions: {
					show: { operation: ['getStatus', 'start', 'stop', 'deallocate', 'manageTags'] },
				},
				description: 'Name of the Virtual Machine. Select a Resource Group above first. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},

			// ------------------------------------------------------------------
			// List options
			// ------------------------------------------------------------------
			{
				displayName: 'Include Power State',
				name: 'includePowerState',
				type: 'boolean',
				default: false,
				displayOptions: { show: { operation: ['list'] } },
				description:
					"Whether to include each VM's runtime power state, as both the raw instanceView (\"Include Power State\") and a friendly top-level \"powerState\" field (e.g. \"running\", \"deallocated\"). Azure's list endpoints don't support expanding instance view directly, so this makes one extra instanceView call per VM returned.",
			},
			{
				displayName: 'Name Filter',
				name: 'nameFilter',
				type: 'string',
				default: '',
				placeholder: 'web',
				displayOptions: { show: { operation: ['list'] } },
				description:
					'Only return VMs whose name contains this text (case-insensitive). Applied client-side, alongside any Filter Groups below — Azure\'s list APIs don\'t support filtering by name.',
			},
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				default: false,
				displayOptions: { show: { operation: ['list'] } },
				description: 'Whether to return all results or only up to a given limit',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				default: 50,
				typeOptions: { minValue: 1 },
				displayOptions: { show: { operation: ['list'], returnAll: [false] } },
				description: 'Max number of results to return',
			},
			{
				displayName: 'Filter Groups',
				name: 'filterGroups',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Filter Group',
				displayOptions: { show: { operation: ['list'] } },
				description:
					'Only return VMs matching these filters. Applied client-side after fetching — Azure\'s list APIs can\'t filter on tag/property values or dates. Conditions within a group combine via "Match Within Group"; groups combine via "Match Between Groups" below — e.g. two groups, each AND-ing two conditions, combined with OR gives (A AND B) OR (C AND D).',
				options: [
					{
						displayName: 'Group',
						name: 'group',
						values: [
							{
								displayName: 'Match Within Group',
								name: 'groupMatchType',
								type: 'options',
								default: 'all',
								options: [
									{ name: 'All Conditions (AND)', value: 'all' },
									{ name: 'Any Condition (OR)', value: 'any' },
								],
							},
							{
								displayName: 'Conditions',
								name: 'conditions',
								type: 'fixedCollection',
								typeOptions: { multipleValues: true },
								default: {},
								placeholder: 'Add Condition',
								options: [
									{
										displayName: 'Row',
										name: 'row',
										values: [
											{
												displayName: 'Condition',
												name: 'condition',
												type: 'options',
												default: 'equals',
												options: [
													{ name: 'Contains', value: 'contains' },
													{ name: 'Date Is After', value: 'dateAfter' },
													{ name: 'Date Is After Now', value: 'dateAfterNow' },
													{ name: 'Date Is Before', value: 'dateBefore' },
													{ name: 'Date Is Before Now', value: 'dateBeforeNow' },
													{ name: 'Equals', value: 'equals' },
													{ name: 'Is Not Set', value: 'isNotSet' },
													{ name: 'Is Set', value: 'isSet' },
													{ name: 'Not Equals', value: 'notEquals' },
												],
											},
											{
												displayName: 'Field Type',
												name: 'fieldType',
												type: 'options',
												default: 'tag',
												options: [
													{ name: 'Tag', value: 'tag' },
													{ name: 'Property Path', value: 'property' },
													{ name: 'Power State', value: 'powerState' },
												],
											},
											{
												displayName: 'Property Path',
												name: 'propertyPath',
												type: 'string',
												default: '',
												placeholder: 'properties.hardwareProfile.vmSize',
												displayOptions: { show: { fieldType: ['property'] } },
												description:
													'Dot/bracket-notation path into the VM\'s JSON output, e.g. "location", "properties.provisioningState", "properties.hardwareProfile.vmSize". Run List VMs once without filters to see the full shape. For power state specifically, use the "Power State" field type instead — it needs "Include Power State" turned on above.',
											},
											{
												displayName: 'Tag Name',
												name: 'tagName',
												type: 'string',
												default: '',
												placeholder: 'ValidUpto',
												displayOptions: { show: { fieldType: ['tag'] } },
											},
											{
												displayName: 'Value',
												name: 'value',
												type: 'string',
												default: '',
												placeholder: '2026-01-01, or an expression like {{ $now }}',
												displayOptions: {
													show: {
														condition: ['dateBefore', 'dateAfter', 'equals', 'notEquals', 'contains'],
													},
												},
												description:
													'Comparison value. Supports expressions — e.g. ={{ $now }} or ={{ $now.minus({ days: 30 }) }} for a rolling date.',
											},
										],
									},
								],
							},
						],
					},
				],
			},
			{
				displayName: 'Match Between Groups',
				name: 'filterGroupsMatchType',
				type: 'options',
				default: 'all',
				displayOptions: { show: { operation: ['list'] } },
				options: [
					{ name: 'All Groups (AND)', value: 'all' },
					{ name: 'Any Group (OR)', value: 'any' },
				],
				description: 'How to combine multiple Filter Groups above. With only one group, this has no effect.',
			},

			// ------------------------------------------------------------------
			// Start / Stop / Deallocate options
			// ------------------------------------------------------------------
			{
				displayName: 'Wait for Completion',
				name: 'waitForCompletion',
				type: 'boolean',
				default: true,
				displayOptions: { show: { operation: ['start', 'stop', 'deallocate'] } },
				description:
					'Whether to poll Azure until the power operation finishes before returning the VM\'s properties. When off, the VM is fetched immediately and may still show its previous state.',
			},
			{
				displayName: 'Poll Interval (Seconds)',
				name: 'pollInterval',
				type: 'number',
				default: 5,
				typeOptions: { minValue: 1 },
				displayOptions: {
					show: { operation: ['start', 'stop', 'deallocate'], waitForCompletion: [true] },
				},
				description: 'How often to check on the operation while waiting',
			},
			{
				displayName: 'Timeout (Seconds)',
				name: 'timeout',
				type: 'number',
				default: 300,
				typeOptions: { minValue: 1 },
				displayOptions: {
					show: { operation: ['start', 'stop', 'deallocate'], waitForCompletion: [true] },
				},
				description: 'Maximum time to wait for the operation to complete before failing',
			},

			// ------------------------------------------------------------------
			// Manage Tags
			// ------------------------------------------------------------------
			{
				displayName: 'Tag Operation',
				name: 'tagOperation',
				type: 'options',
				default: 'addUpdate',
				noDataExpression: true,
				displayOptions: { show: { operation: ['manageTags'] } },
				options: [
					{
						name: 'Add or Update Tag',
						value: 'addUpdate',
						description: 'Set one tag, leaving all other existing tags untouched',
					},
					{
						name: 'Remove Tag',
						value: 'remove',
						description: 'Delete one tag, leaving all other existing tags untouched',
					},
					{
						name: 'Replace All Tags',
						value: 'replace',
						description: 'Overwrite the VM\'s entire tag set with the tags given below',
					},
				],
			},
			{
				displayName: 'Tag Key',
				name: 'tagKey',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: { operation: ['manageTags'], tagOperation: ['addUpdate', 'remove'] },
				},
			},
			{
				displayName: 'Tag Value',
				name: 'tagValue',
				type: 'string',
				default: '',
				displayOptions: {
					show: { operation: ['manageTags'], tagOperation: ['addUpdate'] },
				},
			},
			{
				displayName: 'Tags',
				name: 'tags',
				type: 'fixedCollection',
				default: {},
				typeOptions: { multipleValues: true },
				displayOptions: {
					show: { operation: ['manageTags'], tagOperation: ['replace'] },
				},
				options: [
					{
						displayName: 'Tag',
						name: 'tag',
						values: [
							{ displayName: 'Key', name: 'key', type: 'string', default: '' },
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
				description: 'The complete set of tags the VM should have after this operation',
			},
		],
	};

	methods = {
		loadOptions: {
			async getSubscriptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const subscriptions = await azureApiRequestAllItems.call(
					this,
					'GET',
					'/subscriptions',
					{},
					{},
					true,
					0,
					'2022-12-01',
				);

				return subscriptions
					.filter((sub) => sub.state === 'Enabled')
					.map((sub) => ({
						name: `${sub.displayName as string} (${sub.subscriptionId as string})`,
						value: sub.subscriptionId as string,
					}))
					.sort((a, b) => a.name.localeCompare(b.name));
			},

			async getResourceGroups(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const subscriptionId = this.getCurrentNodeParameter('subscriptionId') as string;
				if (!subscriptionId) return [];

				const resourceGroups = await azureApiRequestAllItems.call(
					this,
					'GET',
					`/subscriptions/${subscriptionId}/resourcegroups`,
					{},
					{},
					true,
					0,
					'2021-04-01',
				);

				return resourceGroups
					.map((rg) => ({ name: rg.name as string, value: rg.name as string }))
					.sort((a, b) => a.name.localeCompare(b.name));
			},

			// Same as getResourceGroups, but sourced from the multi-selected
			// "Subscriptions" field used by the List VMs operation. Since
			// resource group names are only unique within a subscription, each
			// option's value encodes its subscription as "subscriptionId::rgName"
			// so execute() can tell them apart again.
			async getResourceGroupsForList(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const subscriptionIds = (this.getCurrentNodeParameter('subscriptionIds') as string[]) ?? [];
				if (subscriptionIds.length === 0) return [];

				const options: INodePropertyOptions[] = [];

				for (const subscriptionId of subscriptionIds) {
					const resourceGroups = await azureApiRequestAllItems.call(
						this,
						'GET',
						`/subscriptions/${subscriptionId}/resourcegroups`,
						{},
						{},
						true,
						0,
						'2021-04-01',
					);

					for (const rg of resourceGroups) {
						options.push({
							name:
								subscriptionIds.length > 1
									? `${rg.name as string} (sub: ${subscriptionId})`
									: (rg.name as string),
							value: `${subscriptionId}::${rg.name as string}`,
						});
					}
				}

				return options.sort((a, b) => a.name.localeCompare(b.name));
			},

			async getVirtualMachines(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const subscriptionId = this.getCurrentNodeParameter('subscriptionId') as string;
				const resourceGroup = this.getCurrentNodeParameter('resourceGroup') as string;
				if (!subscriptionId || !resourceGroup) return [];

				const vms = await azureApiRequestAllItems.call(
					this,
					'GET',
					`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/virtualMachines`,
					{},
					{},
					true,
					0,
					COMPUTE_API_VERSION,
				);

				return vms
					.map((vm) => ({ name: vm.name as string, value: vm.name as string }))
					.sort((a, b) => a.name.localeCompare(b.name));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				if (operation === 'list') {
					const scope = this.getNodeParameter('scope', i) as string;
					const includePowerState = this.getNodeParameter('includePowerState', i) as boolean;
					const nameFilter = (this.getNodeParameter('nameFilter', i, '') as string).toLowerCase();
					const returnAll = this.getNodeParameter('returnAll', i) as boolean;
					const limit = returnAll ? 0 : (this.getNodeParameter('limit', i) as number);
					const rawGroups =
						((this.getNodeParameter('filterGroups', i, {}) as IDataObject).group as Array<{
							groupMatchType: 'all' | 'any';
							conditions?: IDataObject;
						}>) ?? [];
					const filterGroups: FilterGroup[] = rawGroups.map((g) => ({
						groupMatchType: g.groupMatchType ?? 'all',
						conditions: ((g.conditions as IDataObject)?.row as FilterRow[]) ?? [],
					}));
					const filterGroupsMatchType = this.getNodeParameter(
						'filterGroupsMatchType',
						i,
						'all',
					) as 'all' | 'any';
					const hasFilters = nameFilter.length > 0 || filterGroups.some((g) => g.conditions.length > 0);

					// Fan out over every selected subscription (Entire Subscription
					// scope) or every selected subscription+resource-group pair
					// (Specific Resource Group scope), merging all the results.
					let targets: Array<{ subscriptionId: string; resourceGroup?: string }>;

					if (scope === 'resourceGroup') {
						const rgSelections = this.getNodeParameter('resourceGroups', i) as string[];
						targets = rgSelections.map((value) => {
							const [subscriptionId, resourceGroup] = value.split('::');
							return { subscriptionId, resourceGroup };
						});
					} else {
						const subscriptionIds = this.getNodeParameter('subscriptionIds', i) as string[];
						targets = subscriptionIds.map((subscriptionId) => ({ subscriptionId }));
					}

					for (const target of targets) {
						const basePath = target.resourceGroup
							? `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/Microsoft.Compute/virtualMachines`
							: `/subscriptions/${target.subscriptionId}/providers/Microsoft.Compute/virtualMachines`;

						// Neither the resource-group-scoped "List" nor the
						// subscription-wide "List All" endpoint accepts
						// $expand=instanceView on a plain listing — Azure only
						// allows it paired with a $filter scoped to a specific
						// VM Scale Set. So when power state is wanted, fetch
						// each returned VM's instanceView separately instead.
						//
						// When Filter Groups are set, "Limit" has to apply to the
						// *filtered* results, not the raw fetch, so the raw
						// fetch can't stop early in that case.
						let vms = await azureApiRequestAllItems.call(
							this,
							'GET',
							basePath,
							{},
							{},
							returnAll || hasFilters,
							hasFilters ? 0 : limit,
						);

						if (includePowerState) {
							for (const vm of vms) {
								vm.instanceView = await (azureApiRequest<IDataObject>).call(
									this,
									'GET',
									`${vm.id as string}/instanceView`,
									{},
									{},
									COMPUTE_API_VERSION,
								);
								vm.powerState = extractPowerState(vm) ?? null;
							}
						}

						// Add subscriptionId / resourceGroup before filtering so they
						// can be targeted by a "Property Path" filter condition too.
						for (const vm of vms) {
							addResourceIds(vm);
						}

						if (nameFilter) {
							vms = vms.filter((vm) => (vm.name as string).toLowerCase().includes(nameFilter));
						}
						if (filterGroups.some((g) => g.conditions.length > 0)) {
							vms = vms.filter((vm) => vmMatchesFilters(vm, filterGroups, filterGroupsMatchType));
						}
						if (hasFilters && !returnAll) {
							vms = vms.slice(0, limit);
						}

						for (const vm of vms) {
							returnData.push({ json: vm, pairedItem: { item: i } });
						}
					}
					continue;
				}

				// Every remaining operation acts on a single, specific VM.
				const subscriptionId = this.getNodeParameter('subscriptionId', i) as string;
				const resourceGroup = this.getNodeParameter('resourceGroup', i) as string;
				const vmName = this.getNodeParameter('vmName', i) as string;
				const vmPath = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/virtualMachines/${vmName}`;

				if (operation === 'getStatus') {
					const vm = (await azureApiRequest.call(
						this,
						'GET',
						vmPath,
						{},
						{ $expand: 'instanceView' },
						COMPUTE_API_VERSION,
					)) as IDataObject;
					vm.powerState = extractPowerState(vm) ?? null;
					addResourceIds(vm);
					returnData.push({ json: vm, pairedItem: { item: i } });
					continue;
				}

				if (operation === 'start' || operation === 'stop' || operation === 'deallocate') {
					const waitForCompletion = this.getNodeParameter('waitForCompletion', i) as boolean;

					const response = (await azureApiRequest.call(
						this,
						'POST',
						`${vmPath}/${POWER_ACTIONS[operation]}`,
						{},
						{},
						COMPUTE_API_VERSION,
						true, // need the response headers to find the async-operation URL
					)) as IN8nHttpFullResponse;

					if (waitForCompletion && response.statusCode === 202) {
						const operationUrl =
							(response.headers?.['azure-asyncoperation'] as string) ??
							(response.headers?.['location'] as string);

						if (operationUrl) {
							const pollInterval = (this.getNodeParameter('pollInterval', i) as number) * 1000;
							const timeout = (this.getNodeParameter('timeout', i) as number) * 1000;
							await waitForAzureOperation.call(this, operationUrl, pollInterval, timeout);
						}
					}

					const vm = (await azureApiRequest.call(
						this,
						'GET',
						vmPath,
						{},
						{ $expand: 'instanceView' },
						COMPUTE_API_VERSION,
					)) as IDataObject;
					vm.powerState = extractPowerState(vm) ?? null;
					addResourceIds(vm);
					returnData.push({ json: vm, pairedItem: { item: i } });
					continue;
				}

				if (operation === 'manageTags') {
					const tagOperation = this.getNodeParameter('tagOperation', i) as string;

					let azureOperation: 'Merge' | 'Delete' | 'Replace';
					let tags: IDataObject;

					if (tagOperation === 'addUpdate') {
						azureOperation = 'Merge';
						tags = {
							[this.getNodeParameter('tagKey', i) as string]: this.getNodeParameter(
								'tagValue',
								i,
							) as string,
						};
					} else if (tagOperation === 'remove') {
						azureOperation = 'Delete';
						// The Delete operation on the Tags API only looks at the keys;
						// the values are ignored, so any placeholder value works.
						tags = { [this.getNodeParameter('tagKey', i) as string]: '' };
					} else {
						azureOperation = 'Replace';
						const tagPairs = (
							(this.getNodeParameter('tags', i) as IDataObject).tag as IDataObject[]
						) ?? [];
						tags = tagPairs.reduce((acc: IDataObject, pair) => {
							const key = pair.key as string;
							if (key) acc[key] = pair.value as string;
							return acc;
						}, {});
					}

					await azureApiRequest.call(
						this,
						'PATCH',
						`${vmPath}/providers/Microsoft.Resources/tags/default`,
						{ operation: azureOperation, properties: { tags } },
						{},
						TAGS_API_VERSION,
					);

					const vm = (await azureApiRequest.call(
						this,
						'GET',
						vmPath,
						{},
						{ $expand: 'instanceView' },
						COMPUTE_API_VERSION,
					)) as IDataObject;
					vm.powerState = extractPowerState(vm) ?? null;
					addResourceIds(vm);
					returnData.push({ json: vm, pairedItem: { item: i } });
					continue;
				}

				throw new NodeOperationError(this.getNode(), `Unknown operation "${operation}"`, {
					itemIndex: i,
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				// Errors from azureApiRequest/waitForAzureOperation/the "Unknown
				// operation" guard above are already NodeApiError/NodeOperationError;
				// anything else (a bug, an unexpected throw) gets wrapped so n8n
				// always renders a proper node error rather than a raw exception.
				const isNodeError = error instanceof NodeApiError || error instanceof NodeOperationError;
				const nodeError = isNodeError
					? (error as NodeApiError | NodeOperationError)
					: new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
				throw nodeError;
			}
		}

		return [returnData];
	}
}
