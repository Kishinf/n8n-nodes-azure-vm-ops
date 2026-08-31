import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	IHttpRequestOptions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';

import { AZURE_ENVIRONMENTS } from '../../credentials/AzureVmOAuth2Api.credentials';

type AzureVmCredentials = {
	environment: string;
};

/**
 * Makes a request against the Azure Resource Manager API, authenticated via
 * the "azureVmOAuth2Api" credential (see
 * credentials/AzureVmOAuth2Api.credentials.ts — it extends n8n's built-in
 * oAuth2Api type, so n8n core handles the actual client_credentials token
 * exchange/caching/refresh).
 *
 * `endpoint` may be a path relative to the Resource Manager base URL (e.g.
 * `/subscriptions/.../virtualMachines/foo`) or a fully-qualified URL (used
 * when following an Azure-AsyncOperation / nextLink URL, which Azure already
 * returns fully-qualified with its own api-version).
 *
 * `T` defaults to a plain JSON object; pass `IN8nHttpFullResponse` when
 * `returnFullResponse` is true and the caller needs status/headers.
 */
export async function azureApiRequest<T = IDataObject>(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	body: IDataObject = {},
	qs: IDataObject = {},
	apiVersion = '2024-07-01',
	returnFullResponse = false,
): Promise<T> {
	const credentials = (await this.getCredentials(
		'azureVmOAuth2Api',
	)) as unknown as AzureVmCredentials;
	const env = AZURE_ENVIRONMENTS[credentials.environment] ?? AZURE_ENVIRONMENTS.azurePublic;

	const isFullUrl = endpoint.startsWith('http://') || endpoint.startsWith('https://');
	const url = isFullUrl ? endpoint : `${env.resourceManager}${endpoint}`;

	// A fully-qualified continuation URL (nextLink / Azure-AsyncOperation URL)
	// already carries its own api-version; don't clobber it.
	const query: IDataObject = isFullUrl ? { ...qs } : { 'api-version': apiVersion, ...qs };

	const options: IHttpRequestOptions = {
		method,
		url,
		qs: query,
		json: true,
		returnFullResponse,
	};

	if (Object.keys(body).length > 0) {
		options.body = body;
	}

	try {
		return (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'azureVmOAuth2Api',
			options,
		)) as T;
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
}

/**
 * Follows Azure's `nextLink` pagination for list endpoints, collecting items
 * from the `value` array. Honors n8n's standard returnAll/limit convention.
 */
export async function azureApiRequestAllItems(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	body: IDataObject = {},
	qs: IDataObject = {},
	returnAll = true,
	limit = 50,
	apiVersion = '2024-07-01',
): Promise<IDataObject[]> {
	const results: IDataObject[] = [];
	let nextUrl: string | undefined = endpoint;
	let isFirst = true;

	while (nextUrl) {
		const response = await (azureApiRequest<IDataObject>).call(
			this,
			method,
			nextUrl,
			body,
			isFirst ? qs : {},
			apiVersion,
		);
		isFirst = false;

		const page = (response.value as IDataObject[]) ?? [];
		results.push(...page);

		if (!returnAll && results.length >= limit) {
			return results.slice(0, limit);
		}

		nextUrl = response.nextLink as string | undefined;
	}

	return results;
}

/**
 * Polls an Azure long-running-operation (LRO) status URL — the value of the
 * `Azure-AsyncOperation` (preferred) or `Location` response header returned
 * by actions like start/powerOff/deallocate — until it reaches a terminal
 * state or the timeout elapses.
 */
export async function waitForAzureOperation(
	this: IExecuteFunctions,
	operationUrl: string,
	pollIntervalMs: number,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (true) {
		const status = await (azureApiRequest<IDataObject>).call(this, 'GET', operationUrl, {}, {});
		const state = (status.status as string) ?? 'Succeeded';

		if (state === 'Succeeded') {
			return;
		}
		if (state === 'Failed' || state === 'Canceled') {
			throw new NodeOperationError(
				this.getNode(),
				`Azure operation ended with status "${state}": ${JSON.stringify(status.error ?? status)}`,
			);
		}

		if (Date.now() >= deadline) {
			throw new NodeOperationError(
				this.getNode(),
				`Timed out waiting for the Azure operation to complete (last status: "${state}")`,
			);
		}

		await sleep(pollIntervalMs);
	}
}
