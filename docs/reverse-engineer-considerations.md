
Could I use omnifocus on the web to generate a remote MCP server for omnifocus

19:33
I'm not aware of OmniFocus offering a web-based interface that could serve as the basis for a remote MCP server. OmniFocus is primarily a native macOS/iOS application without a first-party web app.

Let me search for any recent developments on this:


OmniFocus web app remote API MCP server 2024 2025
10 results





















The short answer is no — OmniFocus doesn't have a web interface 
GitHub
. All the existing MCP servers for OmniFocus work via AppleScript/JXA (JavaScript for Automation) running locally on macOS, communicating directly with the OmniFocus application.

Here's what exists:

Zapier MCP for OmniFocus — Zapier offers an OmniFocus MCP server that creates a remotely-accessible endpoint 
Zapier
, but it's limited to basic actions (like creating inbox tasks) and operates through Zapier's infrastructure, not directly against your OmniFocus database.
Local MCP servers (themotionmachine, mdoel, duquesnay, mojenmojen forks) — These use AppleScript to communicate with OmniFocus, allowing them to interact with the application's native functionality 
GitHub
. They require OmniFocus running on a Mac and can only serve clients on the same machine (or via SSH tunneling).
Options for remote access:

SSH tunnel to your Mac running a local OmniFocus MCP server
Tailscale/Cloudflare Tunnel to expose your local MCP server securely
Zapier MCP for basic inbox creation (though much less capable than local servers)
OmniFocus's Mail Drop for sending tasks via email (not MCP, but works remotely)
Would you like help setting up one of these approaches? The SSH/Tailscale option would give you full OmniFocus MCP functionality remotely while keeping your data secure.

https://web.omnifocus.com exists and so in theory you could screen-scrape it / reverse engineer the API it uses

19:35
Ah, you're right — I wasn't aware OmniFocus had launched a web app. That's interesting.


favicon
Fetched
OmniFocus for the Web Test
omnifocus.com

Interesting — so it does exist. Let me look for any documentation on the API it uses:


OmniFocus web API sync server reverse engineer
10 results





















This is gold. OmniFocus for the Web has a front-end written in React that talks to "API hosts" which sit between the front end and the shared model code. The front end doesn't talk directly to the shared code — instead, they've created an API. 
Omnifocus

So in theory, yes — you could reverse-engineer the API that the React front-end uses. The architecture is:

React front-end (in browser) →
API hosts →
Shared OmniFocus model code (running on Omni's Mac servers)
The approach would be:

Inspect network traffic — Open dev tools while using web.omnifocus.com and examine the API calls the React app makes
Authenticate — Figure out how authentication works (likely OAuth against your Omni Account)
Document the endpoints — Map out the API structure for tasks, projects, tags, perspectives etc.
Build an MCP server — Create a remote MCP server that proxies to those endpoints
Considerations:

Omni's position on reverse-engineering is cautious — they note that third-party clients using reverse-engineered sync "can make for unpredictable results, including corrupting your database" 
The Omni Group
 — though that's about sync protocol, not the web API
The web API is likely more stable since it's what their own front-end uses
You'd need to handle authentication token management
Rate limiting / terms of service are unknowns
Existing prior art: At least one person has already built a scraper for the web interface to send SMS notifications for urgent tasks 
The Omni Group
 — so the concept is proven, albeit "janky" by their own admission.

Would you like me to do a deeper dive into what the actual API calls look like? I could outline what you'd need to capture in dev tools to map out the endpoints.

Sure, go ahead

19:37
Let me look at what we can learn about the API structure:


web.omnifocus.com API endpoints network requests GraphQL REST
10 results





















That search didn't reveal the specific OmniFocus web API. Let me create a practical guide for what you'd need to do to reverse-engineer it:


Creating a guide for reverse-engineering the OmniFocus web API to build a remote MCP server
omnifocus-web-api-reverse-engineering.md

Presented file
I've put together a guide for the reverse-engineering approach. The key steps would be:

Immediate reconnaissance (5-10 minutes in DevTools):

Log into web.omnifocus.com with Network tab open
Perform basic operations (view inbox, create task, complete task)
Look for the API base URL and whether it's REST or GraphQL
Capture the auth token format
What I'd expect to find:

Given it's a React app, likely either REST or GraphQL
Authentication probably OAuth-based against your Omni Account
WebSocket connection for real-time sync notifications (based on what we learned about their push notification architecture)
The pragmatic question: Is this worth the effort versus just SSH-tunneling to a local MCP server on your Mac? The web API approach gives you true remote access without needing your Mac running, but:

More fragile (undocumented API could change)
More complex auth management
Unknown rate limits
If you do want to proceed, the first concrete step would be to spend 10 minutes in DevTools capturing the actual API structure. Happy to help analyse whatever you find there.

Omnifocus web api reverse engineering
Document · MD 





Claude is AI and can make mistakes. Please double-check cited sources.
Omnifocus web api reverse engineering · MD
Copy

# Reverse-Engineering OmniFocus for the Web API

## Overview

OmniFocus for the Web (web.omnifocus.com) is a React-based frontend that communicates with Omni's "API hosts" which sit between the browser and the actual OmniFocus model code running on their Mac servers.

The goal: capture and document the API calls to build a remote MCP server that can operate OmniFocus from anywhere.

---

## Step 1: Capture Network Traffic

### Setup
1. Open Chrome/Firefox DevTools (F12 or Cmd+Option+I)
2. Go to the **Network** tab
3. Check "Preserve log" to keep requests across page navigations
4. Filter by "Fetch/XHR" to focus on API calls
5. Navigate to https://web.omnifocus.com and log in

### What to Look For

**Authentication Flow:**
- Look for requests to OAuth endpoints or session establishment
- Note any tokens in headers (Authorization, Cookie, custom headers)
- Check if tokens are JWT (they'll have three base64 sections separated by dots)

**API Base URL:**
- Likely something like `api.omnifocus.com`, `web-api.omnifocus.com`, or similar
- Could be GraphQL (single `/graphql` endpoint) or REST (multiple endpoints)

**Request Patterns to Capture:**

| Action | What to do in UI | Expected API call |
|--------|------------------|-------------------|
| Load inbox | Click Inbox perspective | GET tasks, filtered |
| Load projects | Click Projects | GET projects list |
| View task detail | Click a task | GET single task |
| Create task | Add new task | POST task |
| Complete task | Check checkbox | PATCH/PUT task |
| Edit task | Modify fields | PATCH/PUT task |
| Delete task | Delete a task | DELETE task |
| Load tags | View tags | GET tags |
| Load perspectives | Switch perspective | GET perspective config |

---

## Step 2: Document the API Schema

### For Each Endpoint, Record:

```
Endpoint: [URL path]
Method: [GET/POST/PUT/PATCH/DELETE]
Headers:
  - Authorization: [token type and format]
  - Content-Type: [usually application/json]
  - [any custom headers like X-OmniFocus-*]
  
Request Body (if applicable):
{
  // JSON structure
}

Response Body:
{
  // JSON structure with field types
}

Notes:
- [Any observations about pagination, filtering, etc.]
```

### If It's GraphQL

Look for:
- Single `/graphql` endpoint
- POST requests with `query` or `mutation` in the body
- Schema introspection query (query { __schema { ... } })

Capture the schema if possible:
```graphql
query IntrospectionQuery {
  __schema {
    types {
      name
      fields {
        name
        type { name kind }
      }
    }
  }
}
```

---

## Step 3: Authentication Strategy

### Token Management

1. **Initial Auth**: How do you get a token?
   - OAuth flow with Omni Account?
   - Session cookie?
   - API key?

2. **Token Refresh**: Do tokens expire?
   - Look for 401 responses followed by token refresh
   - Check token expiry in JWT payload if applicable

3. **For MCP Server**: You'll need to either:
   - Store refresh token and handle renewal
   - Use long-lived API key if available
   - Implement OAuth device flow for initial setup

---

## Step 4: Build the MCP Server

### Architecture

```
┌─────────────────────┐
│  Claude / AI Client │
└─────────┬───────────┘
          │ MCP Protocol (stdio or HTTP)
          ▼
┌─────────────────────┐
│  OmniFocus MCP      │
│  Server (Node/Python)│
└─────────┬───────────┘
          │ HTTPS (reverse-engineered API)
          ▼
┌─────────────────────┐
│  web.omnifocus.com  │
│  API hosts          │
└─────────────────────┘
```

### Suggested MCP Tools to Implement

```typescript
// Core task operations
list_tasks(filter?: { project?: string, tag?: string, perspective?: string })
get_task(taskId: string)
create_task(task: { name: string, project?: string, dueDate?: string, ... })
update_task(taskId: string, updates: Partial)
complete_task(taskId: string)
delete_task(taskId: string)

// Project operations
list_projects(folder?: string)
get_project(projectId: string)
create_project(project: { name: string, folder?: string, ... })

// Tag operations
list_tags()
get_tag(tagId: string)

// Perspective operations
list_perspectives()
get_perspective_contents(perspectiveId: string)

// Utility
search(query: string)
get_inbox()
get_forecast()  // Due soon view
```

### Sample MCP Server Skeleton (TypeScript)

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

class OmniFocusWebClient {
  private baseUrl = "https://[discovered-api-url]";
  private token: string;
  
  constructor(token: string) {
    this.token = token;
  }
  
  async request(method: string, path: string, body?: any) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return response.json();
  }
  
  async listTasks(filter?: any) {
    // Implement based on discovered API
  }
  
  async createTask(task: any) {
    // Implement based on discovered API
  }
  
  // ... other methods
}

const server = new Server(
  { name: "omnifocus-web", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_tasks",
      description: "List tasks from OmniFocus",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Filter by project name" },
          tag: { type: "string", description: "Filter by tag" },
        },
      },
    },
    // ... more tools
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const client = new OmniFocusWebClient(process.env.OMNIFOCUS_TOKEN!);
  
  switch (request.params.name) {
    case "list_tasks":
      return { content: [{ type: "text", text: JSON.stringify(await client.listTasks(request.params.arguments)) }] };
    // ... handle other tools
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
```

---

## Step 5: Deployment Options

### Option A: Local Server with Remote Tunnel
- Run MCP server on your Mac
- Expose via Cloudflare Tunnel or Tailscale
- Claude.ai connects to tunnel endpoint

### Option B: Cloud Deployment
- Deploy to AWS Lambda, Cloudflare Workers, or similar
- Store credentials securely (env vars, secrets manager)
- Configure as HTTP-based MCP server

### Option C: Hybrid
- Auth token refresh runs locally (where you can re-authenticate)
- Stateless API calls can run from cloud

---

## Risks and Considerations

1. **API Stability**: Omni could change their API without notice
2. **Terms of Service**: Check if this violates Omni's ToS
3. **Rate Limiting**: Unknown - build in exponential backoff
4. **Data Integrity**: Test thoroughly before trusting with real data
5. **Authentication**: Token management adds complexity

---

## Alternative: Contribute to Omni

Consider reaching out to Omni Group directly. They're developer-friendly and might:
- Provide official API documentation
- Create an official remote MCP server
- Offer guidance on supported integration patterns

Contact: omnifocus-web@omnigroup.com

---

## Next Steps

1. [ ] Capture authentication flow
2. [ ] Document 5-10 core API endpoints
3. [ ] Identify if GraphQL or REST
4. [ ] Build minimal proof-of-concept
5. [ ] Test with non-critical data first
6. [ ] Expand to full MCP tool set

