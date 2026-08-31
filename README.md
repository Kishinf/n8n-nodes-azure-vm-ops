# n8n-nodes-azure-vm

An n8n community node for operating and monitoring **Azure Virtual Machines** through the Azure Resource Manager (ARM) API — list VMs across one or more subscriptions/resource groups, check status, start/stop/deallocate, and manage tags. Every operation outputs the VM's full ARM properties, including all tags.

All Subscription / Resource Group / VM Name fields are dropdowns fetched live from Azure (via the credential's Service Principal) rather than free-text — no need to go copy IDs and names out of the portal.

## Operations

| Operation | What it does | Azure REST call(s) |
|---|---|---|
| **List VMs** | Lists VMs across one or more selected subscriptions, or one or more selected resource groups (multi-select) | `GET .../virtualMachines` (paginates via `nextLink`, one call per selected subscription/resource group). Azure's list endpoints only allow `$expand=instanceView` paired with a Virtual Machine Scale Set `$filter`, which doesn't apply here — so "Include Power State" instead makes one extra `GET .../instanceView` call per VM returned. |
| **Get Status** | Returns a VM's current properties + power/provisioning state | `GET .../virtualMachines/{name}?$expand=instanceView` |
| **Start** | Starts a stopped/deallocated VM | `POST .../virtualMachines/{name}/start` |
| **Stop** | Powers off a VM (compute resources stay allocated — still billed) | `POST .../virtualMachines/{name}/powerOff` |
| **Deallocate** | Stops the VM and releases compute resources (no compute billing) | `POST .../virtualMachines/{name}/deallocate` |
| **Manage Tags** | Add/update one tag, remove one tag, or replace the entire tag set | `PATCH .../providers/Microsoft.Resources/tags/default` |

Start/Stop/Deallocate are long-running Azure operations. By default the node polls until the operation finishes (configurable poll interval / timeout) and then re-fetches the VM so the output always reflects the final state; polling can be turned off if you'd rather fire-and-forget.

Manage Tags uses Azure's dedicated `Microsoft.Resources/tags/default` sub-resource with `Merge` / `Delete` / `Replace` semantics, so adding or removing a single tag never clobbers the VM's other existing tags (a plain `PATCH` on the VM resource itself would overwrite the whole tags object).

Every operation's output includes the VM's ARM resource — `id`, `name`, `location`, `tags`, and the full `properties` object (hardware profile, OS profile, network profile, provisioning state, and — when requested — `instanceView` power state). Get Status/Start/Stop/Deallocate/Manage Tags always include this; List VMs includes it when **Include Power State** is on.

Every output item also gets two convenience top-level fields parsed out of the resource `id`, so downstream nodes don't have to string-split it: **`subscriptionId`** and **`resourceGroup`** (both `null` if `id` is missing or unparseable). And — for Get Status/Start/Stop/Deallocate/Manage Tags always, and for List VMs when **Include Power State** is on — a friendly top-level **`powerState`** field (e.g. `"running"`, `"deallocated"`, `"stopped"`) parsed out of the raw `instanceView.statuses` array, so you don't have to dig through it yourself — `null` if Azure hasn't reported one.

### Name Filter (List VMs)

A quick, always-available filter: only return VMs whose name contains the given text (case-insensitive). It's applied client-side alongside Filter Groups below — Azure's list APIs don't support filtering by name. For anything beyond a simple substring match (exact match, regex-like `Contains`/`Equals`/`Not Equals` on the name, or combining it with other conditions), use a Filter Group with **Field Type: Property Path**, Property Path `name`.

### Filter Groups (List VMs)

Azure's list APIs can't filter on tag or property *values* at all — only exact tag-name/value matches via the generic Resources API, never dates or other VM properties — so filtering happens client-side, after fetching.

Each condition row picks a **Field Type**:
- **Tag** — looks up a tag by name (case-insensitive)
- **Property Path** — a dot/bracket path into the VM's JSON output, e.g. `location`, `properties.provisioningState`, `properties.hardwareProfile.vmSize`. Run List VMs once without filters to see the full shape and find the path you need.
- **Power State** — the friendly power state (`running`, `deallocated`, `stopped`, …) parsed out of `instanceView.statuses`; requires **Include Power State** turned on above, since that's what populates `instanceView` in the first place.

...then a **Condition** (Equals/Not Equals/Contains/Is Set/Is Not Set/Date Is Before/After[ Now]) and, for most conditions, a **Value** — which supports n8n expressions, so a rolling window like "expiring in the next 7 days" is `Date Is Before` with Value `={{ $now.plus({ days: 7 }) }}`. Date values are parsed with JS's `Date` constructor, so ISO 8601 (`2026-01-01` or `2026-01-01T00:00:00Z`) is the reliable format for tags you intend to filter on.

Conditions are organised into **groups** to support mixed AND/OR logic: conditions inside one group combine via that group's **Match Within Group** (AND/OR), and separate groups combine via the top-level **Match Between Groups** (AND/OR). So two groups — each AND-ing two conditions — combined with OR between groups gives `(A AND B) OR (C AND D)`. A single group with a few conditions covers the simple "all must match" or "any must match" cases.

Example — expired VMs, in either West US 2 or East US:
- **Group 1** (Match Within Group: All): Tag `ValidUpto`, Date Is Before Now — AND — Property Path `location`, Equals `westus2`
- **Group 2** (Match Within Group: All): Tag `ValidUpto`, Date Is Before Now — AND — Property Path `location`, Equals `eastus`
- **Match Between Groups: Any**

`Limit` is applied *after* Tag Filters, so it still caps the final result count rather than the raw pre-filter fetch.

## Credentials

Create an **Azure VM OAuth2 API** credential with a Service Principal (App Registration):

1. In Entra ID, create an **App Registration** and a **Client Secret** for it.
2. Grant it an RBAC role on the subscription or resource group you want it to manage — at minimum **Virtual Machine Contributor** (or **Reader** if you only need List/Get Status).
3. In n8n, fill in:
   - **Environment** — Azure Public Cloud, US Government, China, or Germany
   - **Tenant ID**, **Client ID**, **Client Secret**

The credential extends n8n's built-in `oAuth2Api` type, pre-configured for the OAuth2 `client_credentials` grant against Azure AD (`https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`, scope `{resourceManager}/.default`) — token exchange, caching, and refresh are handled by n8n core the same way as any other OAuth2 credential, not by custom code in this package.

> **Upgrading from ≤ 0.1.6?** The credential type was renamed from `azureVmApi` ("Azure VM API") to `azureVmOAuth2Api` ("Azure VM OAuth2 API") to satisfy n8n's naming convention for OAuth2 credentials, and its internals switched from a custom token exchange to extending n8n's built-in `oAuth2Api`. This is a breaking change: any credential you created under the old type is now orphaned. Create a new **Azure VM OAuth2 API** credential with the same Tenant ID/Client ID/Client Secret/Environment, then re-select it on every node that used the old one.

**Subscription** is set per node (not on the credential) — a Service Principal isn't bound to one subscription, so it lives with the other resource-scope parameters (Resource Group, VM Name) rather than with the auth fields. The dropdown lists whatever subscriptions the Service Principal can see (`GET /subscriptions`); it still needs an RBAC role assignment on each one it should be able to operate on.

## Development

```bash
npm install
npm run build
```

To use locally against an n8n instance, either `npm link` this package into your n8n installation's custom nodes folder, or copy `dist/` + `package.json` there. See the [n8n community nodes docs](https://docs.n8n.io/integrations/community-nodes/) for details.

## Notes / limitations

- "List VMs" runs one paginated call per selected subscription (or per selected subscription+resource-group pair) and merges the results; `Return All` / `Limit` apply per target, not to the merged total.
- The single-VM operations (Get Status/Start/Stop/Deallocate/Manage Tags) always target exactly one VM, so their Subscription/Resource Group/VM Name dropdowns are single-select and cascade — pick Subscription, then Resource Group, then VM Name.
- The Service Principal must have RBAC access to whatever subscription/resource group/VM you point the node at — n8n only performs the ARM calls, it doesn't manage role assignments. It needs at least **Reader** on a subscription just for it to show up in these dropdowns.
