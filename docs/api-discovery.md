# OmniFocus Web API Discovery

## Date: 2026-01-19

## Architecture Overview

OmniFocus for the Web uses a **WebSocket-based sync protocol**, not a traditional REST API.

```
┌─────────────────────────┐
│  Browser (React App)    │
└───────────┬─────────────┘
            │ 1. Get instance
            ▼
┌─────────────────────────┐
│  Coordinator            │
│  c.omnifocus.com/api/0  │
└───────────┬─────────────┘
            │ Returns: ws_url, jwk, request_id
            ▼
┌─────────────────────────┐
│  WebSocket Server       │
│  wss://iN.api.omnifocus │
│  .com/c/{SESSION_ID}    │
└───────────┬─────────────┘
            │ Real-time sync (encrypted)
            ▼
┌─────────────────────────┐
│  OmniFocus Model        │
│  (runs on Omni servers) │
└─────────────────────────┘
```

## Discovered Endpoints

### 1. Coordinator API
```
GET https://c.omnifocus.com/api/0/get-instance
    ?account={email}
    &version=*
    &locale=en-GB
    &timezone=Europe/London
```

**Response:**
```json
{
  "ws_url": "wss://i2.api.omnifocus.com/c/{SESSION_ID}",
  "jwk": {
    "kty": "EC",
    "crv": "P-384",
    "x": "...",
    "y": "..."
  },
  "request_id": "REQGJPV9018"
}
```

### 2. Accounts API
```
GET https://accounts.omnigroup.com/api/1.1/trial/
    ?bundle_id=com.omnigroup.OmniFocus.Web
```
Returns 403 without authentication.

## Authentication

- Initial login uses Omni Account credentials (email/password)
- Returns session tokens stored in browser (blocked from introspection)
- WebSocket connection uses EC P-384 cryptography (JWK)
- Likely uses signed tokens or challenge-response for WS auth

## Key Observations

1. **Not REST-based**: The actual data sync happens over WebSocket, not HTTP requests
2. **Encrypted protocol**: Uses elliptic curve cryptography (P-384)
3. **Stateful connection**: WebSocket maintains persistent connection for sync
4. **Server-side model**: The OmniFocus model runs on Omni's Mac servers, not in browser

## Implications for MCP Server

### Challenges

1. **WebSocket complexity**: Would need to implement the full WS protocol
2. **Crypto layer**: Must handle EC P-384 key exchange/verification
3. **Undocumented protocol**: The WS message format is unknown
4. **Session management**: Need to handle coordinator negotiation

### Feasibility Assessment

**Difficulty: HIGH**

This is significantly more complex than a simple REST API reverse-engineering:

| Aspect | REST API | OmniFocus Web |
|--------|----------|---------------|
| Protocol | HTTP | WebSocket |
| Encryption | TLS only | TLS + app-level EC crypto |
| State | Stateless | Stateful session |
| Messages | JSON req/res | Unknown binary/JSON? |
| Complexity | Low | High |

### Recommended Approach

1. **Option A: Abandon web API approach**
   - Use SSH tunnel to local AppleScript MCP server
   - Simpler, more reliable, fully documented

2. **Option B: Deep reverse engineering**
   - Capture WebSocket frames (need browser devtools WS inspector)
   - Reverse engineer the message format
   - Implement the crypto handshake
   - Build a WS client that speaks the protocol
   - Estimate: 40-80 hours of work, fragile result

3. **Option C: Contact Omni Group**
   - Ask about official API or remote access options
   - They might provide guidance or be interested in MCP integration

## Next Steps (if proceeding)

1. [ ] Capture WebSocket frames in Chrome DevTools
2. [ ] Identify message format (JSON, protobuf, custom binary?)
3. [ ] Understand the crypto handshake
4. [ ] Determine if messages are signed/encrypted at app level
5. [ ] Build proof-of-concept WS client

## Alternative: Simpler Screen-Scraping

Since we have browser access, a simpler (but fragile) approach:

- Use Puppeteer/Playwright to automate the web UI
- Click buttons, read DOM state
- No need to reverse engineer the protocol
- But: slow, fragile, breaks on UI changes

## Conclusion

The WebSocket + crypto architecture makes this a **non-trivial reverse engineering project**. The SSH tunnel approach to a local MCP server is likely the pragmatic choice for personal use.
