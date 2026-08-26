import type {
	IAuthenticate,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

// Azure cloud environments and their Resource Manager / Active Directory endpoints.
// Exported so GenericFunctions.ts can resolve the right Resource Manager base
// URL from the "environment" field without duplicating this table.
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

interface AzureVmCredentialData {
	environment: string;
	tenantId: string;
	clientId: string;
	clientSecret: string;
}

interface CachedToken {
	accessToken: string;
	expiresAt: number; // epoch ms
}

// Module-level cache so a token fetched for one request can be reused by
// later ones too (Azure AD tokens are valid for ~60-90 minutes), instead of
// exchanging a fresh token on every single API call.
const tokenCache = new Map<string, CachedToken>();

/**
 * Exchanges the Service Principal's credentials for an access token using the
 * OAuth2 client_credentials grant against Azure AD / Entra ID, caching it
 * until shortly before it expires.
 *
 * This lives here (rather than being handled by n8n's built-in generic OAuth2
 * credential type) because that implementation has known issues with the
 * client_credentials grant specifically (see n8n-io/n8n#16857). It's plumbed
 * in via `authenticate` as a plain function — see below — which runs outside
 * of any node's execution context, so it uses the global `fetch` rather than
 * `this.helpers.httpRequest`.
 */
async function getCachedAccessToken(data: AzureVmCredentialData): Promise<string> {
	const env = AZURE_ENVIRONMENTS[data.environment] ?? AZURE_ENVIRONMENTS.azurePublic;
	const cacheKey = `${data.tenantId}:${data.clientId}:${env.name}`;
	const cached = tokenCache.get(cacheKey);
	const now = Date.now();

	if (cached && cached.expiresAt - 60_000 > now) {
		return cached.accessToken;
	}

	const body = new URLSearchParams({
		grant_type: 'client_credentials',
		client_id: data.clientId,
		client_secret: data.clientSecret,
		scope: `${env.resourceManager}/.default`,
	});

	const response = await fetch(`${env.activeDirectory}/${data.tenantId}/oauth2/v2.0/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body,
	});

	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(
			`Failed to authenticate against Azure AD (${response.status}): ${text || response.statusText}. Check Tenant ID, Client ID and Client Secret.`,
		);
	}

	const json = (await response.json()) as { access_token: string; expires_in: number };
	tokenCache.set(cacheKey, {
		accessToken: json.access_token,
		expiresAt: now + json.expires_in * 1000,
	});
	return json.access_token;
}

/**
 * Credentials for an Azure AD App Registration (Service Principal) that will be
 * used with the OAuth2 "client credentials" grant to call the Azure Resource
 * Manager API (management.azure.com) on behalf of an application (no user
 * sign-in / consent screen involved).
 */
export class AzureVmApi implements ICredentialType {
	name = 'azureVmApi';

	displayName = 'Azure VM API';

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
		{
			displayName: 'Client ID',
			name: 'clientId',
			type: 'string',
			default: '',
			required: true,
			description: 'The Application (client) ID of the App Registration / Service Principal',
		},
		{
			displayName: 'Client Secret',
			name: 'clientSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'A client secret created for the App Registration',
		},
	];

	// A plain function (rather than the declarative IAuthenticateGeneric form)
	// so it can run the client_credentials exchange itself instead of assuming
	// a token is already sitting on the credential. GenericFunctions.ts calls
	// requests through `httpRequestWithAuthentication('azureVmApi', ...)`,
	// which invokes this for every request and attaches the resulting header.
	authenticate: IAuthenticate = async (credentials, requestOptions) => {
		const accessToken = await getCachedAccessToken(credentials as unknown as AzureVmCredentialData);
		requestOptions.headers = {
			...requestOptions.headers,
			Authorization: `Bearer ${accessToken}`,
		};
		return requestOptions;
	};

	// n8n runs `authenticate` above first (the real client_credentials
	// exchange) to attach the Bearer header, then fires this request through
	// it — so the "Test" button on the credential validates the whole chain,
	// not just that Azure AD hands back a token.
	test: ICredentialTestRequest = {
		request: {
			baseURL:
				'={{ { azurePublic: "https://management.azure.com", azureUsGovernment: "https://management.usgovcloudapi.net", azureChina: "https://management.chinacloudapi.cn", azureGermany: "https://management.microsoftazure.de" }[$credentials.environment] }}',
			url: '/subscriptions',
			qs: { 'api-version': '2022-12-01' },
			method: 'GET',
		},
	};
}
