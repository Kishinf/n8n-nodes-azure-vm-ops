import type { IDataObject } from 'n8n-workflow';

export type FilterFieldType = 'tag' | 'property' | 'powerState';

export type FilterCondition =
	| 'isSet'
	| 'isNotSet'
	| 'equals'
	| 'notEquals'
	| 'contains'
	| 'dateBeforeNow'
	| 'dateAfterNow'
	| 'dateBefore'
	| 'dateAfter';

export interface FilterRow {
	fieldType: FilterFieldType;
	tagName?: string;
	propertyPath?: string;
	condition: FilterCondition;
	value?: string;
}

export interface FilterGroup {
	groupMatchType: 'all' | 'any';
	conditions: FilterRow[];
}

/**
 * Azure's list APIs can't filter on tag values (only exact tag-name/value
 * matches via the generic Resources API, never on parsed dates or on any
 * other VM property), so all of this is applied client-side after fetching.
 *
 * Filters are organised as groups of conditions: conditions within a group
 * combine with that group's own AND/OR, and groups combine with each other
 * via a separate top-level AND/OR — e.g. two groups, each AND-ing two
 * conditions, combined with OR between groups gives
 * (A AND B) OR (C AND D).
 */

// Tag names are case-sensitive in Azure, but users typing them into a filter
// row are prone to mis-casing, so look the key up case-insensitively.
function getTagValue(tags: IDataObject | undefined, tagName: string): string | undefined {
	if (!tags) return undefined;
	const key = Object.keys(tags).find((k) => k.toLowerCase() === tagName.toLowerCase());
	return key === undefined ? undefined : (tags[key] as string);
}

// Resolves a dot/bracket-notation path (e.g. "properties.hardwareProfile.vmSize"
// or "properties.instanceView.statuses[0].displayStatus") against the VM's
// JSON output. Missing segments resolve to undefined rather than throwing.
function getByPath(source: unknown, path: string): unknown {
	const parts = path
		.replace(/\[(\w+)\]/g, '.$1')
		.split('.')
		.filter((part) => part.length > 0);

	let current: unknown = source;
	for (const part of parts) {
		if (current === undefined || current === null) return undefined;
		current = (current as IDataObject)[part];
	}
	return current;
}

// Convenience field: extracts the friendly power state (e.g. "running",
// "deallocated") from instanceView.statuses. Azure puts instanceView in two
// different places depending on how it was fetched: top-level on the result
// of the standalone GET .../instanceView call (used for List, since Azure's
// list endpoints don't support $expand=instanceView at all), and nested
// under `properties` when fetched via GET .../virtualMachines/{name}
// ?$expand=instanceView (used everywhere else). Check both.
export function extractPowerState(vm: IDataObject): string | undefined {
	const instanceView =
		(vm.instanceView as IDataObject) ?? ((vm.properties as IDataObject)?.instanceView as IDataObject);
	const statuses = (instanceView?.statuses as IDataObject[]) ?? [];
	const status = statuses.find(
		(s) => typeof s.code === 'string' && (s.code as string).startsWith('PowerState/'),
	);
	return status ? (status.code as string).slice('PowerState/'.length) : undefined;
}

function resolveFieldValue(vm: IDataObject, row: FilterRow): string | undefined {
	if (row.fieldType === 'tag') {
		return getTagValue(vm.tags as IDataObject, row.tagName ?? '');
	}
	if (row.fieldType === 'powerState') {
		return extractPowerState(vm);
	}

	const raw = getByPath(vm, row.propertyPath ?? '');
	if (raw === undefined || raw === null) return undefined;
	return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

function evaluateRow(vm: IDataObject, row: FilterRow): boolean {
	const value = resolveFieldValue(vm, row);

	switch (row.condition) {
		case 'isSet':
			return value !== undefined && value !== '';
		case 'isNotSet':
			return value === undefined || value === '';
		case 'equals':
			return value !== undefined && value === row.value;
		case 'notEquals':
			return value === undefined || value !== row.value;
		case 'contains':
			return value !== undefined && value.includes(row.value ?? '');
		case 'dateBeforeNow':
		case 'dateAfterNow':
		case 'dateBefore':
		case 'dateAfter': {
			if (value === undefined) return false;
			const fieldDate = new Date(value);
			if (Number.isNaN(fieldDate.getTime())) return false;

			if (row.condition === 'dateBeforeNow') return fieldDate.getTime() < Date.now();
			if (row.condition === 'dateAfterNow') return fieldDate.getTime() > Date.now();

			const compareDate = new Date(row.value ?? '');
			if (Number.isNaN(compareDate.getTime())) return false;

			return row.condition === 'dateBefore'
				? fieldDate.getTime() < compareDate.getTime()
				: fieldDate.getTime() > compareDate.getTime();
		}
		default:
			return true;
	}
}

function evaluateGroup(vm: IDataObject, group: FilterGroup): boolean {
	if (group.conditions.length === 0) return true;
	const results = group.conditions.map((row) => evaluateRow(vm, row));
	return group.groupMatchType === 'any' ? results.some(Boolean) : results.every(Boolean);
}

export function vmMatchesFilters(
	vm: IDataObject,
	groups: FilterGroup[],
	groupsMatchType: 'all' | 'any',
): boolean {
	const activeGroups = groups.filter((g) => g.conditions.length > 0);
	if (activeGroups.length === 0) return true;

	const results = activeGroups.map((group) => evaluateGroup(vm, group));
	return groupsMatchType === 'any' ? results.some(Boolean) : results.every(Boolean);
}
