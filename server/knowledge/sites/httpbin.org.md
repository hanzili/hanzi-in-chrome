# httpbin.org

## Overview
httpbin.org is a free, open-source service for testing HTTP requests and responses. It exposes many endpoints that let you experiment with different HTTP methods, headers, authentication methods, status codes, redirects, and payload formats. Developers use it to verify how their HTTP clients behave without needing to build their own test server.

## Site Navigation
- **Home page**: Lists all available endpoints grouped by category with short descriptions. Scroll to find the endpoint you need (e.g., `GET /get`, `POST /anything`, `DELETE /status/:code`).
- **Endpoint links**: Each endpoint is a hyperlink. Clicking it immediately makes a request using your browser, showing the raw JSON response or triggering the appropriate HTTP behavior (redirects, errors, etc.).
- **Documentation**: Each endpoint description explains the request type and what to expect in the response (parameters, behavior).

## Key Workflows

### 1. Test a Basic GET Request
1. Open the home page.
2. Click **`/get`** under the “HTTP Methods” section.
3. The browser displays JSON reflecting your request (headers, origin IP, any query parameters).

### 2. Send Query Parameters
1. Modify the URL to `https://httpbin.org/get?name=test&value=123`.
2. Reload. The JSON response shows `args` containing your parameters.

### 3. Test Different HTTP Methods
1. Use a tool like curl or your HTTP client to make requests to endpoints such as:
   - `POST https://httpbin.org/post`
   - `PUT https://httpbin.org/put`
   - `DELETE https://httpbin.org/delete`
2. Include body data or headers as needed. The response echoes what the server received.

### 4. Simulate Status Codes
1. Use `https://httpbin.org/status/418` (replace `418` with any code).
2. Observe your client’s behavior for success, error, or informational responses.

### 5. Test Redirects
1. Request `https://httpbin.org/redirect/3` to follow 3 redirects.
2. Use `https://httpbin.org/relative-redirect/2` to test relative redirects.
3. Monitor how your client handles Location headers.

### 6. Authentication Endpoints
- `https://httpbin.org/basic-auth/user/passwd`: Requires HTTP Basic auth with username `user` and password `passwd`.
- `https://httpbin.org/digest-auth/auth/user/passwd`: Tests HTTP Digest authentication.
- `https://httpbin.org/bearer`: Expects a Bearer token in the `Authorization` header.

### 7. Inspect Headers or User-Agent
- `/headers` returns the request headers sent by your client.
- `/user-agent` echoes the `User-Agent` string.

### 8. Send JSON or Form Data
1. `POST https://httpbin.org/post` with `Content-Type: application/json` and a JSON body. The response’s `json` field shows what was received.
2. For form data, use `application/x-www-form-urlencoded` or multipart; the response provides parsed fields.

## Authentication
- Most endpoints require no authentication.
- For Basic or Digest auth endpoints:
  1. Include credentials via your HTTP client (e.g., `curl -u user:passwd https://httpbin.org/basic-auth/user/passwd`).
  2. Successful responses show `{ "authenticated": true, "user": "user" }`.
- For Bearer auth, set `Authorization: Bearer <token>`; the service confirms the token value.

## Tips & Quirks
- **HTTPS recommended**: Use `https://` to avoid mixed-content restrictions.
- **Rate limits**: Not explicitly stated, but it’s polite to avoid heavy or automated load.
- **Dynamic data**: Responses reflect your IP, headers, data, and query parameters. Use this to debug request construction.
- **Streaming endpoints** (`/stream/:n`, `/drip`) allow testing chunked responses and throttling.
- **Cache testing**: `/cache/:value` and `/etag/:value` simulate caching behavior, useful for client validations.
- **Anything endpoint**: `/anything` responds to any method and returns details about the request path, headers, and body—handy for generic tests.

Use httpbin.org whenever you need a predictable target to inspect how your HTTP client requests are formed and interpreted.

---


## Learned from: "httpbin.org overview research"

- Opening with `read_page` on `chrome://newtab/` triggers a Chrome restriction (“Chrome blocks extensions from interacting...”), so start directly with `navigate` to the target URL to avoid the error.
- Once on httpbin, using `get_page_text` gives a concise summary; no extra interactions were necessary since the homepage already explains its endpoints clearly.