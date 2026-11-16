---
title: "Zero-downtime deployments on Azure: slots, feature flags, and pipelines"
description: "Deployment slots, warm-up, approval gates, and feature flags in Azure DevOps and GitHub Actions, plus how the same ideas apply to Function Apps and AKS."
pubDate: 2026-10-19
category: devops
format: "How-to"
heroImage: "/images/covers/zero-downtime-deployments-azure.jpg"
seoTitle: ""
seoDescription: ""
featured: true
draft: false
---
A deployment is zero-downtime when nobody outside the team can tell it happened. No failed requests, no slow first page while the app warms up, no stuck queue messages, and a way back that takes seconds instead of a redeploy.

Most downtime during a deploy comes from a short list of causes: the app restarts cold in front of live traffic, a schema change lands before the code that understands it, configuration differs between environments, or in-flight requests are killed when an instance stops. The pattern below addresses each one, and it works the same whether the pipeline runs in Azure DevOps or GitHub Actions.

## The pattern

1. Build once. The artifact that passes staging is the exact artifact that reaches production.
2. Deploy to a staging slot (or new pods) that receives no customer traffic.
3. Warm it up and smoke test it against real dependencies.
4. Swap or shift traffic, with an approval gate in front of production.
5. Keep the previous version one step away so rollback is the same operation in reverse.
6. Release new behavior with feature flags, separately from the deploy.

## App Service: deployment slots

A slot is a live copy of your app with its own hostname. When you swap, App Service warms up the source slot, then switches the routing rules so the warm instances take production traffic. The old production code ends up in `staging`, which is what makes rollback cheap. Slots need a Standard plan or higher.

The part that catches teams out is configuration. App settings and connection strings swap with the code by default. Anything that must stay tied to an environment, such as the environment name or the feature-flag label, has to be marked as a slot setting.

```bicep title="app.bicep"
param appName string
param planId string
param location string = resourceGroup().location

var warmup = [
  { name: 'WEBSITE_SWAP_WARMUP_PING_PATH', value: '/healthz/ready' }
  { name: 'WEBSITE_SWAP_WARMUP_PING_STATUSES', value: '200' }
]

resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  properties: {
    serverFarmId: planId
    httpsOnly: true
    siteConfig: {
      alwaysOn: true
      healthCheckPath: '/healthz'
      appSettings: concat(warmup, [
        { name: 'AppConfig__Label', value: 'production' }
      ])
    }
  }
}

resource staging 'Microsoft.Web/sites/slots@2023-12-01' = {
  parent: app
  name: 'staging'
  location: location
  properties: {
    serverFarmId: planId
    siteConfig: {
      alwaysOn: true
      healthCheckPath: '/healthz'
      appSettings: concat(warmup, [
        { name: 'AppConfig__Label', value: 'staging' }
      ])
    }
  }
}

// Settings named here stay with their slot during a swap
resource sticky 'Microsoft.Web/sites/config@2023-12-01' = {
  parent: app
  name: 'slotConfigNames'
  properties: {
    appSettingNames: [ 'AppConfig__Label' ]
  }
}
```

> **Note:** The warm-up ping path should exercise real dependencies (database, cache, Key Vault) and return 200 only when the app can serve traffic. A `/healthz` that always returns 200 tells the swap nothing.

## Azure DevOps: build, stage, swap

Three stages. Build publishes one artifact. Staging deploys it to the slot and smoke tests it. Production performs only the swap, and runs against an environment that carries the approval check. The service connection uses workload identity federation, so no client secret is stored in the project.

```yaml title="azure-pipelines.yml"
trigger:
  branches:
    include: [ main ]

variables:
  azureSubscription: 'sc-orders-prod'   # workload identity federation
  appName: 'app-orders-prod'
  resourceGroup: 'rg-orders-prod'

stages:
- stage: Build
  jobs:
  - job: build
    pool: { vmImage: ubuntu-latest }
    steps:
    - script: dotnet publish src/Orders.Api -c Release -o $(Build.ArtifactStagingDirectory)/app
    - publish: $(Build.ArtifactStagingDirectory)/app
      artifact: app

- stage: Staging
  dependsOn: Build
  jobs:
  - deployment: deploy_staging
    environment: orders-staging
    pool: { vmImage: ubuntu-latest }
    strategy:
      runOnce:
        deploy:
          steps:
          - task: AzureWebApp@1
            inputs:
              azureSubscription: $(azureSubscription)
              appName: $(appName)
              resourceGroupName: $(resourceGroup)
              deployToSlotOrASE: true
              slotName: staging
              package: $(Pipeline.Workspace)/app
          - script: |
              curl --fail --retry 10 --retry-delay 6 --retry-all-errors \
                https://$(appName)-staging.azurewebsites.net/healthz/ready
            displayName: Smoke test staging slot

- stage: Production
  dependsOn: Staging
  jobs:
  - deployment: swap
    environment: orders-production   # approvals and checks live here
    pool: { vmImage: ubuntu-latest }
    strategy:
      runOnce:
        deploy:
          steps:
          - download: none
          - task: AzureAppServiceManage@0
            inputs:
              azureSubscription: $(azureSubscription)
              Action: 'Swap Slots'
              WebAppName: $(appName)
              ResourceGroupName: $(resourceGroup)
              SourceSlot: staging
```

## GitHub Actions: the same flow

The GitHub version maps one to one. `azure/login` authenticates with OpenID Connect, which needs the `id-token: write` permission and a federated credential on the Entra app registration. Required reviewers go on the `production` environment.

```yaml title=".github/workflows/deploy.yml"
name: deploy
on:
  push:
    branches: [ main ]

permissions:
  id-token: write
  contents: read

env:
  APP_NAME: app-orders-prod
  RESOURCE_GROUP: rg-orders-prod

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with: { dotnet-version: '8.0.x' }
      - run: dotnet publish src/Orders.Api -c Release -o app
      - uses: actions/upload-artifact@v4
        with: { name: app, path: app }

  staging:
    needs: build
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/download-artifact@v4
        with: { name: app, path: app }
      - uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
      - uses: azure/webapps-deploy@v3
        with:
          app-name: ${{ env.APP_NAME }}
          slot-name: staging
          package: app
      - name: Smoke test staging slot
        run: |
          curl --fail --retry 10 --retry-delay 6 --retry-all-errors \
            https://${{ env.APP_NAME }}-staging.azurewebsites.net/healthz/ready

  production:
    needs: staging
    runs-on: ubuntu-latest
    environment: production   # required reviewers
    steps:
      - uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
      - run: |
          az webapp deployment slot swap \
            -g $RESOURCE_GROUP -n $APP_NAME \
            --slot staging --target-slot production
```

> **Note:** Newer App Service apps can use unique default hostnames that include a hash and region. If yours does, read the slot hostname from `az webapp show` instead of building it from the app name.

## Separate deploy from release with feature flags

A swap changes which code is running. A feature flag changes what that code does. Keeping them apart means a risky change can ship dark, be switched on for a few users, and be switched off without touching the pipeline.

Azure App Configuration stores the flags. Each slot reads flags under its own label, and because `AppConfig__Label` is a slot setting, production keeps reading production flags after the swap.

```csharp title="Program.cs"
var label = builder.Configuration["AppConfig:Label"];

builder.Configuration.AddAzureAppConfiguration(options =>
{
    options.Connect(new Uri(builder.Configuration["AppConfig:Endpoint"]!), new DefaultAzureCredential())
           .Select(KeyFilter.Any, label)
           .UseFeatureFlags(flags => flags.Select(KeyFilter.Any, label));
});

builder.Services.AddAzureAppConfiguration();
builder.Services.AddFeatureManagement();

var app = builder.Build();
app.UseAzureAppConfiguration();

app.MapPost("/checkout", async (IFeatureManager features, CheckoutRequest req) =>
    await features.IsEnabledAsync("NewCheckout")
        ? await NewCheckout.Handle(req)
        : await LegacyCheckout.Handle(req));
```

## Database changes: expand, then contract

During a swap, old and new code both run for a short time against the same database. Every schema change has to work with both versions, which means splitting breaking changes across releases.

1. Expand: add the new column or table. Nothing reads it yet.
2. Deploy code that writes to both old and new, and reads from old.
3. Backfill existing rows.
4. Deploy code that reads from new. Flip the flag if behavior changes.
5. Contract: once no deployed version uses the old column, drop it.

Run migrations as their own pipeline step before the slot deploy, never on application startup. Startup migrations race each other when several instances warm up at once.

## Function Apps

Function Apps use the same slot model and the same pipeline tasks (`AzureFunctionApp@2` in Azure DevOps, `Azure/functions-action` in GitHub Actions). Slots are available on Premium and Dedicated plans, and with limits on Consumption. Check the current plan matrix before you depend on them; Flex Consumption did not support slots at the time of writing.

The difference from a web app is triggers. A staging slot runs every function in it, so queue, Service Bus, and timer triggers in staging will consume production messages unless you stop them. Disable them with a slot setting that stays on staging:

```text title="staging slot settings (sticky)"
AzureWebJobs.ProcessOrders.Disabled = true
AzureWebJobs.NightlyReconcile.Disabled = true
```

Because the settings are sticky, they stay on staging after the swap and the newly promoted code in production runs its triggers normally.

## AKS: rolling updates that don’t drop requests

On Kubernetes the equivalent of a slot is a rolling update that never removes capacity before new pods are ready. Four settings do most of the work: `maxUnavailable: 0`, a readiness probe that checks real dependencies, a `preStop` delay so the load balancer stops routing before the container exits, and a PodDisruptionBudget so node upgrades can’t take every replica at once.

```yaml title="orders-api.yaml"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-api
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  selector:
    matchLabels: { app: orders-api }
  template:
    metadata:
      labels: { app: orders-api }
    spec:
      terminationGracePeriodSeconds: 45
      containers:
      - name: api
        image: acrorders.azurecr.io/orders-api:1.42.0
        ports: [ { containerPort: 8080 } ]
        readinessProbe:
          httpGet: { path: /healthz/ready, port: 8080 }
          periodSeconds: 5
          failureThreshold: 3
        lifecycle:
          preStop:
            exec: { command: [ "sleep", "10" ] }
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: orders-api
spec:
  minAvailable: 2
  selector:
    matchLabels: { app: orders-api }
```

In the pipeline, follow `kubectl apply` with `kubectl rollout status deployment/orders-api --timeout=5m` so a failed rollout fails the job. Rolling back is `kubectl rollout undo deployment/orders-api`.

## Rollback

With slots, rollback is another swap. The previous version is still warm in `staging` until the next deploy overwrites it, so swapping again takes seconds. Write the command into the runbook before you need it:

```bash title="rollback.sh"
az webapp deployment slot swap \
  -g rg-orders-prod -n app-orders-prod \
  --slot staging --target-slot production
```

If the problem is behavior behind a flag, turn the flag off instead. That is usually faster than a swap and doesn’t touch the running code.

## Checklist

- One artifact, built once, promoted through every stage.
- Staging slot on a Standard plan or higher, with Always On and a health check path.
- Warm-up ping path that checks real dependencies.
- Environment-specific settings marked as slot settings.
- Approval check on the production environment, not on the build.
- Pipelines authenticate with workload identity federation or OIDC. No stored secrets.
- Schema changes split into expand and contract releases; migrations run as a pipeline step.
- Non-HTTP triggers disabled in Function App staging slots.
- On AKS: maxUnavailable 0, readiness probe, preStop delay, PodDisruptionBudget.
- Rollback command written down and tested.
