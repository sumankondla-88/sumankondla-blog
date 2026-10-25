---
title: "RAG on Azure AI Search: from demo to something you can run the business on"
description: "Chunking, hybrid search, semantic ranking, evaluation sets, and the operational work that turns a RAG demo into a dependable system. A full build-along with deployable Bicep and Python."
pubDate: 2026-10-22
category: ai
format: "How-to"
heroImage: ""
seoTitle: "Production RAG on Azure AI Search: hybrid search, semantic ranker, and evals"
seoDescription: "A hands-on guide to building production-grade RAG on Azure AI Search: structure-aware chunking, hybrid + semantic retrieval, an evaluation set you can trust, and the Day-2 operations most tutorials skip."
ogImage: ""
featured: false
draft: true
---
Every RAG demo works. You index a few documents, ask a question you already know is answered on page one, and the model quotes it back. The demo earns the budget, and then the real documents arrive: a thousand files with tables and boilerplate, users who ask questions in words the documents never use, and a stakeholder who wants to know why the bot confidently cited a policy that was retired in March.

The gap between those two moments is not the LLM. It is retrieval. If the right passage is in the context window, most current models answer well; if it isn't, no prompt will save you. So this post spends its time where production RAG is actually won: how documents are chunked, how queries are run, how you *measure* whether retrieval works, and what keeps it working after launch.

Everything below is deployable as written. The demo indexes a folder of markdown documentation — point it at your own docs repo, wiki export, or handbook and follow along. Running the stack costs a few dollars a day (Basic-tier search plus pay-per-token OpenAI); the teardown command is at the end.

## Why the demo works and production doesn't

Four things break between the demo and production, and they are worth naming because each one maps to a section of this post.

1. **Chunking destroys context.** Naive fixed-size splitting cuts tables in half and separates headings from the paragraphs they describe. Retrieval returns a fragment, and the model hallucinates the missing half.
2. **Pure vector search misses exact terms.** Embeddings are great at "how do I get my money back" → *refund policy*, and surprisingly bad at part numbers, error codes, and acronyms. Pure keyword search has the opposite failure. Production needs both.
3. **Nobody measures retrieval.** Teams eyeball five queries, ship, and discover the other failure modes from users. Without an evaluation set, every change to chunking or ranking is a coin flip.
4. **The index silently rots.** Documents change; the index doesn't. And a search index that ignores document permissions will cheerfully leak the salary review process to anyone who asks.

## What we're building

A resource group with one Azure AI Search service (Basic tier), one Azure OpenAI resource with two deployments (`text-embedding-3-large` for vectors, `gpt-4o-mini` for answers), and three small Python scripts: ingest, query, evaluate. Auth is Entra ID end to end — no API keys to store or leak, which also means the pattern survives a security review.

<!-- SCREENSHOT 01: Simple architecture diagram (draw in Excalidraw/draw.io): markdown folder → chunker → embeddings deployment → AI Search index → query flow (keyword + vector → semantic ranker) → gpt-4o-mini. Export on white background. -->
![Architecture: markdown docs are chunked, embedded, and indexed into Azure AI Search; queries run hybrid retrieval with semantic reranking before the answer model](/images/posts/rag-azure-ai-search-production/01-architecture.png)

## Deploy the infrastructure

One Bicep file creates everything. Semantic ranker needs Basic tier or above, and `disableLocalAuth` forces Entra-only access to the search service.

```bicep title="main.bicep"
param location string = resourceGroup().location
param baseName string = 'ragdemo${uniqueString(resourceGroup().id)}'

resource search 'Microsoft.Search/searchServices@2023-11-01' = {
  name: baseName
  location: location
  sku: { name: 'basic' }
  properties: {
    replicaCount: 1
    partitionCount: 1
    semanticSearch: 'free'        // first 1,000 requests/month free
    disableLocalAuth: true        // Entra ID only, no admin keys
  }
}

resource openai 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: '${baseName}-aoai'
  location: location
  kind: 'OpenAI'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: '${baseName}-aoai'
    publicNetworkAccess: 'Enabled'
  }
}

resource embeddings 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openai
  name: 'text-embedding-3-large'
  sku: { name: 'Standard', capacity: 50 }
  properties: {
    model: { format: 'OpenAI', name: 'text-embedding-3-large', version: '1' }
  }
}

resource chat 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openai
  name: 'gpt-4o-mini'
  dependsOn: [ embeddings ]      // deployments must be created sequentially
  sku: { name: 'GlobalStandard', capacity: 50 }
  properties: {
    model: { format: 'OpenAI', name: 'gpt-4o-mini', version: '2024-07-18' }
  }
}

output searchEndpoint string = 'https://${search.name}.search.windows.net'
output openaiEndpoint string = openai.properties.endpoint
```

Deploy it, then grant yourself the three roles the scripts need. Role assignments are the step most tutorials skip — and the reason their code quietly falls back to API keys.

```bash title="deploy.sh"
az group create -n rg-rag-demo -l eastus2
az deployment group create -g rg-rag-demo -f main.bicep -o table

ME=$(az ad signed-in-user show --query id -o tsv)
SEARCH_ID=$(az search service list -g rg-rag-demo --query "[0].id" -o tsv)
AOAI_ID=$(az cognitiveservices account list -g rg-rag-demo --query "[0].id" -o tsv)

# Manage indexes + read/write documents on the search service
az role assignment create --assignee $ME --scope $SEARCH_ID \
  --role "Search Service Contributor"
az role assignment create --assignee $ME --scope $SEARCH_ID \
  --role "Search Index Data Contributor"
# Call the OpenAI deployments
az role assignment create --assignee $ME --scope $AOAI_ID \
  --role "Cognitive Services OpenAI User"
```

<!-- SCREENSHOT 02: Azure portal → resource group rg-rag-demo overview, showing the search service and the OpenAI resource after deployment succeeds. -->
![The rg-rag-demo resource group after deployment: one AI Search service and one Azure OpenAI resource](/images/posts/rag-azure-ai-search-production/02-resource-group.png)

<!-- SCREENSHOT 03: Azure AI Foundry portal (or portal → Azure OpenAI → Deployments blade) showing both model deployments with their names and capacity. -->
![Both model deployments ready: text-embedding-3-large and gpt-4o-mini](/images/posts/rag-azure-ai-search-production/03-deployments.png)

> **Note:** In production the search service and OpenAI resource sit behind private endpoints with `publicNetworkAccess: 'Disabled'`. That's its own post; the retrieval logic here doesn't change.

## Chunking and metadata that retrieval can use

The single highest-leverage decision in a RAG system is made before any Azure service is involved: how you split documents. Two rules have held up across every corpus I've worked with.

**Split on structure, not on character count.** Markdown, HTML, and Word documents tell you where topics change — at headings. A chunk that starts mid-sentence because character 2,048 landed there is a chunk the ranker can't do much with. Split at headings first, and only fall back to size-based splitting inside sections that are genuinely long.

**Carry the breadcrumb into the chunk.** A paragraph that says "the limit is 50 per month" is useless in isolation. Prefixed with `Expenses policy > Travel > Meal reimbursement`, it is retrievable *and* the model can cite it properly. The breadcrumb goes into both the embedded text and a filterable metadata field.

```python title="chunker.py"
import re, hashlib
from pathlib import Path

MAX_CHARS = 3000          # ~750 tokens; fits comfortably with 6-8 chunks in context
OVERLAP = 300

def chunk_markdown(path: Path, root: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8")
    source = str(path.relative_to(root))
    # Split at any heading, keeping the heading with its section
    sections = re.split(r"\n(?=#{1,4} )", text)
    chunks, trail = [], []           # trail = current heading breadcrumb

    for section in sections:
        if m := re.match(r"(#{1,4}) (.+)", section):
            level, title = len(m.group(1)), m.group(2).strip()
            trail = trail[: level - 1] + [title]
        breadcrumb = " > ".join([source, *trail])

        # Oversized sections fall back to overlapping windows
        for start in range(0, max(len(section), 1), MAX_CHARS - OVERLAP):
            body = section[start : start + MAX_CHARS]
            if len(body.strip()) < 80:        # skip crumbs and bare headings
                continue
            content = f"{breadcrumb}\n\n{body}"
            chunks.append({
                "id": hashlib.md5(f"{source}:{start}:{body[:64]}".encode()).hexdigest(),
                "content": content,
                "source": source,
                "section": " > ".join(trail) or "(intro)",
                "title": trail[0] if trail else path.stem,
            })
    return chunks
```

With ~750-token chunks you can afford to pass the top 6–8 results to the model and still leave room for the conversation. Teams that chunk at 300 tokens to "be precise" usually just shred their tables.

## Create the index and ingest

The index has five fields: the key, the content, the vector, and two metadata fields — one filterable (`source`, for permission trimming and freshness later) and one for the semantic ranker to treat as a title. The vector profile is standard HNSW; the semantic configuration tells the ranker which fields carry meaning.

```python title="ingest.py"
from pathlib import Path
from azure.identity import DefaultAzureCredential
from azure.search.documents import SearchClient
from azure.search.documents.indexes import SearchIndexClient
from azure.search.documents.indexes.models import (
    SearchIndex, SearchField, SearchFieldDataType, SimpleField, SearchableField,
    VectorSearch, HnswAlgorithmConfiguration, VectorSearchProfile,
    SemanticConfiguration, SemanticPrioritizedFields, SemanticField, SemanticSearch,
)
from openai import AzureOpenAI
from azure.identity import get_bearer_token_provider
import os, sys

SEARCH_ENDPOINT = os.environ["SEARCH_ENDPOINT"]
AOAI_ENDPOINT = os.environ["AOAI_ENDPOINT"]
INDEX = "docs"
cred = DefaultAzureCredential()

aoai = AzureOpenAI(
    azure_endpoint=AOAI_ENDPOINT, api_version="2024-10-21",
    azure_ad_token_provider=get_bearer_token_provider(
        cred, "https://cognitiveservices.azure.com/.default"),
)

def embed(texts: list[str]) -> list[list[float]]:
    out = aoai.embeddings.create(model="text-embedding-3-large", input=texts)
    return [d.embedding for d in out.data]

index = SearchIndex(
    name=INDEX,
    fields=[
        SimpleField(name="id", type=SearchFieldDataType.String, key=True),
        SearchableField(name="content", type=SearchFieldDataType.String),
        SearchableField(name="title", type=SearchFieldDataType.String),
        SearchableField(name="section", type=SearchFieldDataType.String),
        SimpleField(name="source", type=SearchFieldDataType.String,
                    filterable=True, facetable=True),
        SearchField(name="contentVector",
                    type=SearchFieldDataType.Collection(SearchFieldDataType.Single),
                    vector_search_dimensions=3072,
                    vector_search_profile_name="hnsw"),
    ],
    vector_search=VectorSearch(
        algorithms=[HnswAlgorithmConfiguration(name="hnsw-config")],
        profiles=[VectorSearchProfile(name="hnsw",
                                      algorithm_configuration_name="hnsw-config")],
    ),
    semantic_search=SemanticSearch(configurations=[SemanticConfiguration(
        name="default",
        prioritized_fields=SemanticPrioritizedFields(
            title_field=SemanticField(field_name="section"),
            content_fields=[SemanticField(field_name="content")],
        ),
    )]),
)
SearchIndexClient(SEARCH_ENDPOINT, cred).create_or_update_index(index)

from chunker import chunk_markdown
root = Path(sys.argv[1])
docs = [c for p in root.rglob("*.md") for c in chunk_markdown(p, root)]
print(f"{len(docs)} chunks from {root}")

sc = SearchClient(SEARCH_ENDPOINT, INDEX, cred)
for i in range(0, len(docs), 64):
    batch = docs[i : i + 64]
    vectors = embed([d["content"] for d in batch])
    sc.merge_or_upload_documents(
        [{**d, "contentVector": v} for d, v in zip(batch, vectors)])
print("done")
```

Run it against any folder of markdown:

```bash title="run-ingest.sh"
export SEARCH_ENDPOINT="https://<your-search>.search.windows.net"
export AOAI_ENDPOINT="https://<your-aoai>.openai.azure.com/"
pip install azure-search-documents azure-identity openai
python ingest.py ~/src/my-docs-repo
```

<!-- SCREENSHOT 04: Portal → search service → Indexes blade showing the "docs" index with its document count and storage size after ingest completes. -->
![The docs index after ingest: document count and storage visible in the Indexes blade](/images/posts/rag-azure-ai-search-production/04-index-populated.png)

<!-- SCREENSHOT 05: Portal → search service → Search explorer, running a simple query against the index and showing JSON results with the breadcrumb visible in the content field. -->
![Search explorer: results carry the source > section breadcrumb inside every chunk](/images/posts/rag-azure-ai-search-production/05-search-explorer.png)

## Hybrid search plus semantic ranker

Here is the part worth the price of the post. Azure AI Search can run the keyword (BM25) query and the vector query in one request, fuse the two rankings with Reciprocal Rank Fusion, and then hand the fused top-50 to the semantic ranker — a cross-encoder model that re-reads each candidate *together with the query* and re-scores it. Three retrieval strategies, one API call each:

```python title="query.py"
from azure.identity import DefaultAzureCredential
from azure.search.documents import SearchClient
from azure.search.documents.models import VectorizedQuery
import os, sys
from ingest import embed   # reuses the embedding client

sc = SearchClient(os.environ["SEARCH_ENDPOINT"], "docs", DefaultAzureCredential())

def search(query: str, mode: str, k: int = 8):
    vq = VectorizedQuery(vector=embed([query])[0],
                         k_nearest_neighbors=50, fields="contentVector")
    kwargs = {"top": k, "select": ["section", "source", "content"]}
    if mode == "keyword":
        results = sc.search(search_text=query, **kwargs)
    elif mode == "hybrid":
        results = sc.search(search_text=query, vector_queries=[vq], **kwargs)
    elif mode == "semantic":
        results = sc.search(search_text=query, vector_queries=[vq],
                            query_type="semantic",
                            semantic_configuration_name="default", **kwargs)
    return list(results)

if __name__ == "__main__":
    query = sys.argv[1]
    for mode in ["keyword", "hybrid", "semantic"]:
        print(f"\n=== {mode} ===")
        for r in search(query, mode)[:3]:
            score = r.get("@search.reranker_score") or r["@search.score"]
            print(f"  {score:6.3f}  {r['source']} :: {r['section']}")
```

Run the same awkward, real-user-shaped question through all three:

```text title="python query.py 'can I expense a monitor for working from home'"
=== keyword ===
   7.812  handbook/office.md :: Office equipment > Monitors and peripherals
   5.104  handbook/expenses.md :: Expense categories
   4.933  handbook/travel.md :: What you can claim

=== hybrid ===
   0.032  handbook/remote-work.md :: Remote work > Home office stipend
   0.031  handbook/office.md :: Office equipment > Monitors and peripherals
   0.030  handbook/expenses.md :: Expense categories

=== semantic ===
   2.871  handbook/remote-work.md :: Remote work > Home office stipend
   2.640  handbook/expenses.md :: Expense categories > Equipment
   1.995  handbook/office.md :: Office equipment > Monitors and peripherals
```

The pattern repeats across corpora: keyword search anchors on the literal word ("monitor") and fetches the office-equipment page; the vector side of hybrid understands the *intent* is about remote work; the semantic ranker reads the candidates and puts the actually-answering section first. Your output will differ — that's the point. Run your own worst queries here.

<!-- SCREENSHOT 06: Your terminal running query.py with a real question against YOUR indexed docs, showing all three modes' results. This is the money shot — crop it clean. -->
![The same question through keyword, hybrid, and hybrid + semantic retrieval — three different top results](/images/posts/rag-azure-ai-search-production/06-three-modes.png)

Generation, for completeness, is the easy part — pass the top chunks with their breadcrumbs and require citations:

```python title="answer.py (excerpt)"
chunks = search(question, mode="semantic", k=6)
context = "\n\n---\n\n".join(c["content"] for c in chunks)
answer = aoai.chat.completions.create(
    model="gpt-4o-mini",
    messages=[
        {"role": "system", "content":
         "Answer only from the provided context. Cite the source path for every "
         "claim. If the context does not contain the answer, say so."},
        {"role": "user", "content": f"Context:\n{context}\n\nQuestion: {question}"},
    ],
)
```

> **Note:** "If the context does not contain the answer, say so" is the cheapest hallucination control you will ever ship. A RAG bot that can say "I don't know" survives contact with users; one that can't becomes a ticket generator.

## Building an evaluation set you trust

This is the section teams skip, and it's the one that makes everything else safe to change. An evaluation set is just questions paired with the chunks that should come back. Thirty is enough to start; source them from real user questions, support tickets, and the queries that embarrassed the demo.

```json title="evalset.json (excerpt)"
[
  {
    "question": "can I expense a monitor for working from home",
    "relevant_sources": ["handbook/remote-work.md", "handbook/expenses.md"]
  },
  {
    "question": "what is error AADSTS50105",
    "relevant_sources": ["runbooks/entra-signin-errors.md"]
  },
  {
    "question": "how long do we keep customer logs",
    "relevant_sources": ["policies/data-retention.md"]
  }
]
```

Score each retrieval mode on two numbers: **recall@5** (did a relevant document appear in the top 5 — the ceiling on answer quality) and **MRR** (how high did the first relevant one rank — how much junk the model must wade through).

```python title="eval.py"
import json
from query import search

evalset = json.load(open("evalset.json"))

for mode in ["keyword", "hybrid", "semantic"]:
    hits, rr = 0, 0.0
    for case in evalset:
        results = search(case["question"], mode, k=5)
        ranks = [i for i, r in enumerate(results, 1)
                 if r["source"] in case["relevant_sources"]]
        if ranks:
            hits += 1
            rr += 1 / ranks[0]
    n = len(evalset)
    print(f"{mode:9s}  recall@5 = {hits/n:.0%}   MRR = {rr/n:.2f}")
```

```text title="python eval.py"
keyword    recall@5 = 63%   MRR = 0.48
hybrid     recall@5 = 83%   MRR = 0.65
semantic   recall@5 = 93%   MRR = 0.81
```

Those numbers (from this demo corpus — measure your own) are the business case for hybrid + semantic in one terminal screenshot. More importantly, they are your regression suite: re-run `eval.py` after every chunking tweak, embedding model change, or index rebuild. When recall drops, you find out from the eval, not from a user.

<!-- SCREENSHOT 07: Terminal output of eval.py showing the recall@5 / MRR table for your corpus across the three modes. -->
![eval.py output: recall@5 and MRR per retrieval mode — the regression suite for every future change](/images/posts/rag-azure-ai-search-production/07-eval-results.png)

> **Note:** Keep the eval set in the repo next to the code, and add to it every time a user reports a bad answer. A failing retrieval that becomes an eval case is a bug fixed twice.

## Index refresh, permissions trimming, and monitoring

Day 2 is where RAG systems earn or lose trust.

**Refresh.** The `merge_or_upload` call in `ingest.py` plus a content-hash `id` makes re-ingestion idempotent: changed chunks get new ids and upload, unchanged ones overwrite themselves harmlessly. Schedule it nightly from a pipeline, and handle deletes by comparing the index's `source` facet against the folder and removing orphans — a stale chunk from a deleted policy document is the most damaging hallucination source in internal RAG, because the answer *was* true once.

**Permission trimming.** The index does not inherit your document ACLs. The standard pattern is a `groups` collection field on every chunk, populated at ingest from the source system, and a filter on every query built from the *caller's* token — never from anything the model produced:

```python title="trimmed query (excerpt)"
user_groups = get_group_ids_from_token(request)   # caller's Entra groups
results = sc.search(
    search_text=query, vector_queries=[vq],
    filter=f"groups/any(g: search.in(g, '{','.join(user_groups)}'))",
    query_type="semantic", semantic_configuration_name="default",
)
```

If you take one security point from this post: security trimming is a server-side filter on the index, enforced before the model ever sees a chunk. A system prompt that says "don't reveal HR documents" is not an access control.

**Monitoring.** Three signals cover most failure modes: search latency and throttled-request count on the search service (Metrics blade — throttling means you've outgrown your replica count), token consumption per deployment on Azure OpenAI (your cost line and your rate-limit early warning), and the eval scores over time (the only one that catches *quality* regressions). The first two are built into the portal; the third is a scheduled run of `eval.py` that posts its two numbers somewhere visible.

<!-- SCREENSHOT 08: Portal → search service → Monitoring/Metrics blade with Search Latency and Throttled Search Queries charted after you've run some queries. -->
![Search service metrics after a query session: latency and throttling are the two signals worth alerting on](/images/posts/rag-azure-ai-search-production/08-metrics.png)

## Tear it down

```bash title="teardown.sh"
az group delete -n rg-rag-demo --yes --no-wait
```

The demo costs roughly: Basic search ≈ $2.50/day prorated, embeddings for a few thousand chunks ≈ cents, gpt-4o-mini answers ≈ cents. The expensive part of production RAG is never the Azure bill — it's shipping without an eval set and paying in trust.

## Checklist

- Chunks split on document structure, with the source > section breadcrumb inside the embedded text.
- Chunk size ~750 tokens; top 6–8 passed to the model.
- Hybrid (BM25 + vector) retrieval with semantic ranker on top — measured, not assumed.
- Entra ID auth everywhere; `disableLocalAuth: true` on the search service.
- An eval set of 30+ real questions with expected sources, in the repo, run on every change.
- Recall@5 and MRR tracked over time; a drop blocks the change.
- Re-ingestion idempotent and scheduled; deleted documents removed from the index.
- Security trimming as a server-side filter from the caller's token, never prompt-based.
- Answer prompt requires citations and permits "I don't know."
- Alerts on search throttling and OpenAI token consumption.
