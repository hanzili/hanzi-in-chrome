# google.com

*Knowledge file created automatically*

---


### search-google-websocket
*Task: Search Google for "WebSocket relay server" and tell me the title of the first result*

**Required Information:**
- search_query: Exact text string to search (e.g., "WebSocket relay server")

**Optional Information:**
- None

**Steps:**
1. Open a browser and go to https://www.google.com.
2. Enter the provided search_query into the search box and submit.
3. Identify the organic first result on the results page (ignore ads or sponsored entries if present).
4. Read and record the title of that first result.
5. Provide the title back to the requester.

**Tips:**
- Ensure you distinguish ads from organic results; sponsored links often appear at the top and should be skipped when identifying the "first result."
- Google login is not required; simply use the main search page.


---


### search-google-general
*Task: Search Google for any query and retrieve the first organic result title*

**Required Information:**
- search_query: Exact text string to search (e.g., "browser automation best practices")

**Optional Information:**
- None

**Steps:**
1. Navigate to https://www.google.com
2. Use form_input to enter the search query into the search box
3. Click the search button (typically located around coordinates 816, 450 on standard resolution)
4. Use read_page or get_page_text to view the search results
5. Identify the first organic result (skip any ads/sponsored content at the top)
6. Extract and report the title of the first organic result

**Tips:**
- The search button click can be performed via left_click at approximately (816, 450)
- Multiple read_page or get_page_text calls may be needed to fully load and parse results
- Organic results typically start after any "Sponsored" or "Ad" labeled entries
- No login required for basic Google searches