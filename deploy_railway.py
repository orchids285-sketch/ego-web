#!/usr/bin/env python3
"""Deploy ego-web on Railway (Dockerfile build) — service + volume + domain + env.

Guard: refuses to run while the Railway account is UNPAID/over-limit (it would fail anyway
with "Usage limit exceeded" and provision nothing).

  export RAILWAY_API_TOKEN=...      # defaults to the project token below
  export EGO_REPO=orchids285-sketch/ego-web
  python deploy_railway.py
"""
import json, os, secrets, subprocess, sys

TOKEN   = os.environ.get("RAILWAY_API_TOKEN", "54a27d9f-f4f4-429d-bb33-c2d02e65f1be")
PROJECT = os.environ.get("RAILWAY_PROJECT", "e0b2217e-25ec-4fa6-ae2d-47cf49d54470")   # "twenty"
ENVV    = os.environ.get("RAILWAY_ENV", "5589c1df-c5ff-4e46-b20c-4a7d180f6b75")       # production
REPO    = os.environ.get("EGO_REPO", "orchids285-sketch/ego-web")
API_KEY = os.environ.get("EGO_API_KEY") or secrets.token_hex(24)


def gql(q, v=None):
    body = {"query": q}
    if v:
        body["variables"] = v
    open("_q.json", "w").write(json.dumps(body))
    out = subprocess.run(
        ["curl", "-s", "-X", "POST", "https://backboard.railway.app/graphql/v2",
         "-H", "Authorization: Bearer " + TOKEN, "-H", "Content-Type: application/json",
         "--data", "@_q.json"], capture_output=True, text=True).stdout
    try:
        return json.loads(out)
    except Exception:
        return {"_raw": out[:300]}


# 0) billing guard ------------------------------------------------------------------
r = gql('query{ me{ workspaces{ customer{ state usageLimit{ isOverLimit } } } } }')
c = ((r.get("data") or {}).get("me") or {}).get("workspaces", [{}])[0].get("customer") or {}
print("Railway billing:", c.get("state"), "| overLimit:", (c.get("usageLimit") or {}).get("isOverLimit"))
if c.get("state") == "UNPAID" or (c.get("usageLimit") or {}).get("isOverLimit"):
    print("[STOP] Railway is frozen (UNPAID / over limit) — nothing provisioned. Settle it, re-run.")
    sys.exit(1)

# 1) service from the repo ----------------------------------------------------------
r = gql('mutation($i:ServiceCreateInput!){ serviceCreate(input:$i){ id } }',
        {"i": {"projectId": PROJECT, "name": "ego-web", "source": {"repo": REPO}}})
svc = (r.get("data") or {}).get("serviceCreate", {}).get("id")
print("service:", svc, r.get("errors", ""))
if not svc:
    sys.exit(1)

# 2) env --------------------------------------------------------------------------
gql('mutation($i:VariableCollectionUpsertInput!){ variableCollectionUpsert(input:$i) }',
    {"i": {"projectId": PROJECT, "environmentId": ENVV, "serviceId": svc,
           "variables": {"EGO_API_KEY": API_KEY, "EGO_DATA_DIR": "/data", "EGO_HEADLESS": "1"}}})

# 3) volume for task spaces (persistent logged-in profiles) -------------------------
gql('mutation($i:VolumeCreateInput!){ volumeCreate(input:$i){ id } }',
    {"i": {"projectId": PROJECT, "environmentId": ENVV, "serviceId": svc, "mountPath": "/data"}})

# 4) public domain ------------------------------------------------------------------
r = gql('mutation($i:ServiceDomainCreateInput!){ serviceDomainCreate(input:$i){ domain } }',
        {"i": {"environmentId": ENVV, "serviceId": svc, "targetPort": 8080}})
dom = (r.get("data") or {}).get("serviceDomainCreate", {}).get("domain")

# 5) deploy ---------------------------------------------------------------------------
gql('mutation($s:String!,$e:String!){ serviceInstanceDeployV2(serviceId:$s, environmentId:$e) }',
    {"s": svc, "e": ENVV})

print("\nego-web deploying.")
print("  viewer : https://%s/?key=%s" % (dom or "<domain>", API_KEY))
print("  agent  : POST https://%s/v1/run   (Authorization: Bearer %s)" % (dom or "<domain>", API_KEY))
print("  NOTE   : give it >=2GB RAM; Chromium will OOM on a 512MB plan.")
