---
title: "Securing AI agents with Entra workload identities and managed identity"
description: "Give every agent its own identity, scope its permissions to the tools it calls, and audit what it did. A working setup on Azure with deployable Bicep and Python."
pubDate: 2026-11-15
category: security
format: "How-to"
heroImage: ""
seoTitle: "Securing AI agents on Azure: managed identity, workload identity federation, and least-privilege RBAC"
seoDescription: "A hands-on guide to AI agent identity on Azure: one managed identity per agent, data-plane RBAC scoped to each tool, federated credentials instead of secrets, Conditional Access for workload identities, and the sign-in logs that show what an agent actually did."
ogImage: ""
featured: false
draft: false
---
Most AI agents in production today run as someone else. They run as the developer who built them, as a shared service principal named `ai-platform-prod`, or as an app registration whose client secret lives in three places, one of them a Teams chat. The agent works, the demo goes well, and nobody can answer the question a security reviewer asks first: *if this agent misbehaves, what can it touch?*

That question matters more for agents than for ordinary applications. A normal app calls the APIs its code calls. An agent calls the tools a model *decides* to call, based on input you don't fully control: a user prompt, a retrieved document, an email it was asked to summarise. Prompt injection turns "what can this agent reach" from a theoretical question into an incident report. You can't prompt your way out of that. The control that works is the same one that has always worked: identity, and least privilege bound to it.

Microsoft is putting agent governance at the centre of Ignite this year (November 17–20), and the platform pieces are moving quickly. The foundation underneath all of it doesn't change, though, and you can build it today with services that are generally available. This post walks through it end to end: one identity per agent, no secrets, permissions scoped to each tool, policy on how agents sign in, and logs that tell you what happened.

## Why agents shouldn't share an identity

A shared identity fails in three ways, and each gets worse as you add agents.

1. **The blast radius is the union of every agent's needs.** If the HR assistant needs the HR document store and the finance agent needs the invoices database, a shared principal can read both. Now a prompt injection in a CV can read invoices.
2. **You can't revoke one agent.** When an agent misbehaves, the fix is to disable its identity. If that identity is shared, you take down every agent with it, so in practice nobody does, and the misbehaving agent keeps running while people debate.
3. **The logs can't tell agents apart.** Every sign-in and every data access says `ai-platform-prod`. When you investigate, you are left matching timestamps against application logs and hoping the clocks agree.

The rule is simple: **one agent, one identity.** "Agent" here means a deployable unit with a distinct purpose and toolset, not every instance. Ten replicas of the HR assistant share one identity; the HR assistant and the finance agent never do.

![Before and after: three agents sharing one service principal with access to everything, versus one managed identity per agent scoped to its own tools](/images/posts/securing-ai-agents-entra-workload-identities/01-shared-vs-per-agent.png)

## Managed identity vs workload identity federation

Azure gives you two ways to give an agent an identity without a secret. Which one you use depends on where the agent runs.

**Managed identity** is for agents running *on* Azure: Container Apps, App Service, Functions, AKS, VMs. Azure creates the identity in Entra ID, issues tokens to the compute it's attached to, and rotates everything behind the scenes. There is no credential for you to store, leak, or rotate. Use a **user-assigned** managed identity rather than system-assigned for agents, for two reasons: its lifecycle is independent of the compute (you can rebuild the container app without losing role assignments), and you can create it and grant its permissions *before* the agent is deployed, which keeps permission changes in a reviewable infrastructure pull request.

**Workload identity federation** is for agents running *outside* Azure, or in places where Azure can't attach an identity directly: GitHub Actions, another cloud, an on-premises Kubernetes cluster, a partner's platform. The external platform already issues the workload a signed token (an OIDC token from GitHub, a service account token from Kubernetes). You tell Entra ID to trust tokens from that issuer with a specific subject, and the workload swaps its token for an Entra token. Again, nothing to store.

Here is the useful detail: **you can add federated credentials to a user-assigned managed identity.** So one identity per agent works everywhere. The production agent on Container Apps uses the identity directly, and the agent's evaluation pipeline in GitHub Actions uses the *same* identity through federation, with the same permissions and the same entry in the logs.

| Where the agent runs | Use | Secret to manage |
|---|---|---|
| Container Apps, App Service, Functions, VMs | User-assigned managed identity | None |
| AKS | Managed identity + AKS workload identity (federation) | None |
| GitHub Actions, other clouds, on-premises Kubernetes | Federated credential on the managed identity | None |
| A SaaS platform that only accepts a client secret | App registration + secret in Key Vault (last resort) | Yes. Rotate it and alert on it |

If you're reaching for a client secret, check the table again. It belongs in the last row only.

### Deploy the identities

This Bicep creates one user-assigned identity per agent and a federated credential so the agent's GitHub workflow can sign in as it. The agent list is a parameter, so adding an agent is a one-line pull request.

```bicep title="identities.bicep"
param location string = resourceGroup().location

@description('One entry per agent. Name is used for the identity and in logs.')
param agents array = [
  { name: 'hr-assistant',  repo: 'contoso/hr-assistant' }
  { name: 'finance-agent', repo: 'contoso/finance-agent' }
]

resource agentIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = [for a in agents: {
  name: 'id-agent-${a.name}'
  location: location
  tags: {
    agent: a.name
    owner: 'platform-team'
  }
}]

// Lets the agent's GitHub workflow (main branch, "production" environment) sign in as the agent.
resource githubFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = [for (a, i) in agents: {
  parent: agentIdentity[i]
  name: 'github-production'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${a.repo}:environment:production'
    audiences: [ 'api://AzureADTokenExchange' ]
  }
}]

output identities array = [for (a, i) in agents: {
  agent: a.name
  clientId: agentIdentity[i].properties.clientId
  principalId: agentIdentity[i].properties.principalId
}]
```

Pin the federated `subject` as tightly as you can. `repo:contoso/hr-assistant:environment:production` means only workflow jobs that target the `production` environment in that repository can become the agent, and you can protect that environment with required reviewers. A subject like `repo:contoso/hr-assistant:ref:refs/heads/main` is looser: any workflow on `main` qualifies.

![Illustration: Two user-assigned managed identities, one per agent, tagged with agent name and owner](/images/posts/securing-ai-agents-entra-workload-identities/02-identities.webp)

![Illustration: The federated credential on the HR assistant identity, trusting only the production environment of its own repository](/images/posts/securing-ai-agents-entra-workload-identities/03-federated-credential.webp)

### Use the identity from the agent

Attach the identity to the compute, then tell the SDK *which* identity to use. Pass the client ID explicitly. If your compute has more than one identity attached and you rely on defaults, you'll get whichever one the platform picks.

```python title="agent_auth.py"
import os
from azure.identity import ManagedIdentityCredential, get_bearer_token_provider
from openai import AzureOpenAI
from azure.search.documents import SearchClient

# Set per deployment; the client ID is not a secret.
credential = ManagedIdentityCredential(client_id=os.environ["AGENT_IDENTITY_CLIENT_ID"])

llm = AzureOpenAI(
    azure_endpoint=os.environ["AOAI_ENDPOINT"],
    azure_ad_token_provider=get_bearer_token_provider(
        credential, "https://cognitiveservices.azure.com/.default"
    ),
    api_version="2024-10-21",
)

hr_docs = SearchClient(
    endpoint=os.environ["SEARCH_ENDPOINT"],
    index_name="hr-policies",
    credential=credential,
)
```

In GitHub Actions, `azure/login` with `client-id` set to the same identity's client ID and `allow-no-subscriptions: true` gets you a token through federation. No `AZURE_CLIENT_SECRET` appears anywhere.

## Scoping tool access with RBAC

An agent's tools are its permissions. Write them down as a table before you write any role assignments: each tool, the resource it touches, and the narrowest built-in role that lets it work.

| Agent | Tool | Resource | Role | Scope |
|---|---|---|---|---|
| hr-assistant | Answer generation | Azure OpenAI account | Cognitive Services OpenAI User | That account |
| hr-assistant | Policy search | AI Search | Search Index Data Reader | That search service |
| hr-assistant | Read attached policy PDFs | Storage | Storage Blob Data Reader | The `hr-policies` **container** |
| finance-agent | Answer generation | Azure OpenAI account | Cognitive Services OpenAI User | That account |
| finance-agent | Invoice lookup | Storage | Storage Blob Data Reader | The `invoices` container |

Three rules make this table hold up.

**Use data-plane roles, never control-plane roles.** `Contributor` on a storage account lets an identity list the account keys, and with the keys it can read everything regardless of RBAC. Agents need roles whose names end in *Data Reader*, *Data Contributor*, or *User*. If an agent's role could delete the resource, it's the wrong role.

**Scope to the resource, or below it.** Assign roles on the specific resource, or on a container or index where the service supports it. Never on the resource group, and never on the subscription. A resource group role assignment quietly extends to whatever someone deploys into that group next month.

**Read before write, and write needs a reason.** Most agent tools only read. When a tool genuinely writes (creating a ticket, updating a record), give it its own narrowly scoped role, and consider putting a human approval step in the agent's flow rather than relying on the model's judgement.

```bicep title="rbac.bicep"
param hrPrincipalId string
param openAiName string
param searchName string
param storageName string

var roles = {
  openAiUser:       '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd' // Cognitive Services OpenAI User
  searchIndexReader:'1407120a-92aa-4202-b7e9-c0e197c71c8f' // Search Index Data Reader
  blobDataReader:   '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1' // Storage Blob Data Reader
}

resource openai 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = { name: openAiName }
resource search 'Microsoft.Search/searchServices@2023-11-01' existing = { name: searchName }
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: storageName }
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}
resource hrContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: blobService
  name: 'hr-policies'
}

resource hrOpenAi 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: openai
  name: guid(openai.id, hrPrincipalId, roles.openAiUser)
  properties: {
    principalId: hrPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.openAiUser)
  }
}

resource hrSearch 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: search
  name: guid(search.id, hrPrincipalId, roles.searchIndexReader)
  properties: {
    principalId: hrPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.searchIndexReader)
  }
}

// Scoped to one container, not the storage account.
resource hrBlobs 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: hrContainer
  name: guid(hrContainer.id, hrPrincipalId, roles.blobDataReader)
  properties: {
    principalId: hrPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.blobDataReader)
  }
}
```

Setting `principalType: 'ServicePrincipal'` matters more than it looks. Without it, a role assignment created moments after the identity can fail because Entra ID hasn't replicated the new principal yet.

To prove the scoping works, run this check after every change. It should show only resource- and container-level scopes, and nothing ending in a resource group name:

```bash title="check-scope.sh"
az role assignment list --all \
  --assignee "$(az identity show -g rg-agents -n id-agent-hr-assistant --query principalId -o tsv)" \
  --query "[].{role:roleDefinitionName, scope:scope}" -o table
```

![Illustration: Role assignments for the HR assistant: three data-plane roles, each scoped to a single resource or container](/images/posts/securing-ai-agents-entra-workload-identities/04-role-assignments.webp)

### When the agent acts for a user

Everything above covers the agent acting *as itself*: reading a shared policy index, say. Many agents also act *for* a user ("summarise my emails", "what's in my team's SharePoint site"). For those tools, don't give the agent's identity access to everyone's data and then filter in code. Use the **on-behalf-of (OBO) flow**: the agent exchanges the user's token for a token to the downstream API, and the call runs with the *user's* permissions. The agent can then never see more than the person asking. This is the same principle as security trimming in RAG: the access check happens at the data source, not in the prompt.

If an agent genuinely needs application-level Microsoft Graph access, pick the narrowest permission that exists. `Sites.Selected` instead of `Sites.Read.All`, for example, with the agent then granted access to specific sites only. `*.ReadWrite.All` on an agent should require a written exception.

## Conditional Access for workload identities

RBAC controls *what* an agent can reach. Conditional Access controls *how and from where* it can sign in, so a credential that leaks is useless outside your network.

**Conditional Access for workload identities** lets you write policies that target service principals: block sign-ins from outside named locations (your egress IPs), and block service principals that Entra ID Protection flags as risky. It needs a **Workload Identities Premium** licence.

There is an important limitation, and it catches people out: **these policies apply to single-tenant service principals (app registrations), not to managed identities.** That's less bad than it sounds. A managed identity has no credential that can leak, and its tokens are only issued to the Azure compute it's attached to. Conditional Access is protecting against the stolen-secret scenario that managed identities eliminate. In practice:

- **Agents on managed identities:** your controls are the identity's attachment to specific compute, tight RBAC, and the network (private endpoints on the resources the agent calls, so a token is only useful from inside your virtual network).
- **Agents that must use an app registration** (the last row of the table earlier): put them in a Conditional Access policy that blocks every location except your known egress IPs, and block high service principal risk.

![Illustration: A Conditional Access policy targeting a workload identity, blocking sign-ins from anywhere except the agent's known egress IPs](/images/posts/securing-ai-agents-entra-workload-identities/05-conditional-access.webp)

Treat this policy as a forcing function. If an agent can't move to a managed identity or federation and needs this policy, put that on record as a known exception with an owner and a review date.

## Logging and reviewing agent actions

You now have one identity per agent, so the logs can finally answer *which agent did what*. You need three layers, because each one answers a different question.

**1. Sign-ins: when did the agent get tokens, and for what?** Entra ID records managed identity and service principal sign-ins separately from user sign-ins. Send them to Log Analytics with a diagnostic setting on Entra ID (the `ManagedIdentitySignInLogs` and `ServicePrincipalSignInLogs` categories). Then this query shows each agent's footprint: every resource it requested a token for, and how often.

```kusto title="agent-footprint.kql"
AADManagedIdentitySignInLogs
| where TimeGenerated > ago(7d)
| where ServicePrincipalName startswith "id-agent-"
| summarize Tokens = count(), Failures = countif(ResultType != "0"),
            LastSeen = max(TimeGenerated)
    by Agent = ServicePrincipalName, Resource = ResourceDisplayName
| order by Agent asc, Tokens desc
```

The useful alert is the *new resource* one: an agent requesting a token for a resource it has never asked for before. Agents are predictable in what they call, so a new row in this table is either a deployment you know about or something to investigate.

![Illustration: Agent footprint query: each agent identity and the resources it requested tokens for over the last seven days](/images/posts/securing-ai-agents-entra-workload-identities/06-footprint.webp)

**2. Data access: what did it read or change?** Turn on resource diagnostic logs for the data stores agents touch: `StorageRead` and `StorageWrite` on blob storage, `AuditEvent` on Key Vault, and request logs on Azure OpenAI and AI Search. These record the caller's object ID, which now maps to exactly one agent.

**3. Intent: why did it do that?** Platform logs can't tell you which user prompt led to which tool call. Your agent code has to. Emit an OpenTelemetry span for every tool call with the agent name, the tool, the target resource, a hash or ID of the conversation, and the outcome, and send it to Application Insights. When an investigation starts from "the finance agent read an invoice it shouldn't have", the platform logs tell you *when*, and this trace tells you *which conversation* and *which prompt*.

```python title="tool_tracing.py"
from opentelemetry import trace

tracer = trace.get_tracer("agents.hr-assistant")

def call_tool(tool_name: str, target: str, conversation_id: str, fn, *args, **kwargs):
    with tracer.start_as_current_span(f"tool.{tool_name}") as span:
        span.set_attribute("agent.name", "hr-assistant")
        span.set_attribute("agent.tool", tool_name)
        span.set_attribute("agent.target", target)
        span.set_attribute("agent.conversation_id", conversation_id)
        try:
            result = fn(*args, **kwargs)
            span.set_attribute("agent.outcome", "ok")
            return result
        except Exception as exc:
            span.set_attribute("agent.outcome", "error")
            span.record_exception(exc)
            raise
```

Don't log full prompts and responses by default. They often contain exactly the sensitive data you're protecting. Log identifiers you can join on, and keep full transcripts in a store with its own access controls and retention period if you need them.

**Review on a schedule.** Once a quarter, for each agent: compare its role assignments to the tool table, compare its sign-in footprint to its role assignments, and remove anything it holds but hasn't used. Permissions that aren't used in ninety days are the first thing an attacker would find, and the easiest thing for you to delete.

## Where Microsoft's agent platform fits

Microsoft is building agent-specific identity and governance on top of Entra ID: a first-class identity type for agents (Microsoft Entra Agent ID) and a management layer for registering and governing agents across a tenant. Expect a lot of it on stage at Ignite. None of it replaces what's above. Those layers still come down to an Entra identity per agent, scoped access to resources, and sign-in and audit logs. If you've already built per-agent identities with tight RBAC, adopting the new tooling is an inventory exercise. If every agent shares one service principal, it's a migration project.


## Checklist

- One user-assigned managed identity per agent, named and tagged so logs identify the agent.
- No client secrets: managed identity on Azure, federated credentials everywhere else.
- Federated credential subjects pinned to a repository *and* a protected environment.
- A written tool table per agent: tool, resource, role, scope.
- Data-plane roles only; nothing that can list keys or delete resources.
- Role assignments scoped to the resource, container, or index. Never the resource group.
- On-behalf-of flow for tools that act on a user's data; narrowest Graph permissions for the rest.
- Conditional Access (location + risk) on any agent that still uses an app registration, recorded as an exception.
- Private endpoints on the data stores agents call.
- Entra managed identity and service principal sign-in logs in Log Analytics, with a "new resource" alert.
- Diagnostic logs on every data store an agent touches.
- An OpenTelemetry span per tool call, joined to the conversation by ID, not full text.
- A quarterly access review that removes anything unused for ninety days.
