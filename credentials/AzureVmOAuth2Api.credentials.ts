import type { ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

// Azure cloud environments and their Resource Manager / Active Directory endpoints.
// Exported so GenericFunctions.ts can resolve the right Resource Manager base
// URL from the "environment" field when building request URLs (a separate
// concern from the OAuth2 token exchange below, which is n8n's own job now).
export const AZURE_ENVIRONMENTS: {
	[key: string]: { name: string; resourceManager: string; activeDirectory: string };
} = {
	azurePublic: {
		name: 'Azure Public Cloud',
		resourceManager: 'https://management.azure.com',
		activeDirectory: 'https://login.microsoftonline.com',
	},
	azureUsGovernment: {
		name: 'Azure US Government',
		resourceManager: 'https://management.usgovcloudapi.net',
		activeDirectory: 'https://login.microsoftonline.us',
	},
	azureChina: {
		name: 'Azure China (21Vianet)',
		resourceManager: 'https://management.chinacloudapi.cn',
		activeDirectory: 'https://login.chinacloudapi.cn',
	},
	azureGermany: {
		name: 'Azure Germany',
		resourceManager: 'https://management.microsoftazure.de',
		activeDirectory: 'https://login.microsoftonline.de',
	},
};

// n8n expression snippets that index a plain object literal by
// {{$self["environment"]}}, used below to build environment-aware hidden
// defaults. Follows the same "$self" pattern n8n-nodes-base itself uses for
// per-tenant OAuth2 credentials (see MicrosoftAzureMonitorOAuth2Api).
const ACTIVE_DIRECTORY_HOST_EXPR = `{{ { ${Object.entries(AZURE_ENVIRONMENTS)
	.map(([key, env]) => `${key}: "${env.activeDirectory.replace('https://', '')}"`)
	.join(', ')} }[$self["environment"]] }}`;

const RESOURCE_MANAGER_URL_EXPR = `{{ { ${Object.entries(AZURE_ENVIRONMENTS)
	.map(([key, env]) => `${key}: "${env.resourceManager}"`)
	.join(', ')} }[$self["environment"]] }}`;

/**
 * Credentials for an Azure AD App Registration (Service Principal) that will be
 * used with the OAuth2 "client credentials" grant to call the Azure Resource
 * Manager API (management.azure.com) on behalf of an application (no user
 * sign-in / consent screen involved).
 *
 * Extends n8n's built-in `oAuth2Api` rather than implementing the token
 * exchange by hand, so token acquisition/caching/refresh is handled by n8n
 * core the same way as every other OAuth2 credential.
 */
export class AzureVmOAuth2Api implements ICredentialType {
	name = 'azureVmOAuth2Api';

	extends = ['oAuth2Api'];

	displayName = 'Azure VM OAuth2 API';

	icon = 'file:../nodes/AzureVmNode/azureVm.svg' as const;

	documentationUrl = 'https://learn.microsoft.com/en-us/rest/api/compute/virtual-machines';

	properties: INodeProperties[] = [
		{
			displayName: 'Environment',
			name: 'environment',
			type: 'options',
			options: Object.entries(AZURE_ENVIRONMENTS).map(([value, env]) => ({
				name: env.name,
				value,
			})),
			default: 'azurePublic',
			description: 'The Azure cloud this Service Principal authenticates against',
		},
		{
			displayName: 'Tenant ID',
			name: 'tenantId',
			type: 'string',
			default: '',
			required: true,
			description: 'The Azure Active Directory (Entra ID) tenant/directory ID',
		},
		// clientId / clientSecret are inherited as-is from oAuth2Api.
		{
			displayName: 'Grant Type',
			name: 'grantType',
			type: 'hidden',
			default: 'clientCredentials',
		},
		{
			displayName: 'Authorization URL',
			name: 'authUrl',
			type: 'hidden',
			// Never actually used (grantType is fixed above), but redeclared for
			// consistency with how n8n-nodes-base extends oAuth2Api elsewhere.
			default: `=https://${ACTIVE_DIRECTORY_HOST_EXPR}/{{$self["tenantId"]}}/oauth2/v2.0/authorize`,
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'hidden',
			default: `=https://${ACTIVE_DIRECTORY_HOST_EXPR}/{{$self["tenantId"]}}/oauth2/v2.0/token`,
		},
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'hidden',
			default: `=${RESOURCE_MANAGER_URL_EXPR}/.default`,
		},
		{
			displayName: 'Authentication',
			name: 'authentication',
			type: 'hidden',
			// Azure AD's token endpoint expects client_id/client_secret in the
			// POST body (client_secret_post), not as a Basic Auth header.
			default: 'body',
		},
	];

	// A lightweight, always-authenticated smoke test: n8n resolves the OAuth2
	// token (per the fields above) and attaches it before firing this request,
	// so a successful "Test" validates the whole chain — token exchange *and*
	// Azure actually accepting it — not just that Azure AD hands back a token.
	test: ICredentialTestRequest = {
		request: {
			baseURL: `=${RESOURCE_MANAGER_URL_EXPR.replace('$self', '$credentials')}`,
			url: '/subscriptions',
			qs: { 'api-version': '2022-12-01' },
			method: 'GET',
		},
	};
}
