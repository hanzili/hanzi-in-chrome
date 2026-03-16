# example.com

A simple example website used for testing and demonstrations.

## Authentication

Standard form-based login at /login.
- Enter username/email and password
- Click the login/submit button
- Look for a user avatar or greeting to confirm you're logged in

## Workflows

### Search for Content

1. Find the search box (usually in the header)
2. Enter your search query
3. Press Enter or click the search button
4. Results load on a new page or dynamically below

### Submit Contact Form

**Location:** /contact

**Required information:**
- Name
- Email address
- Message

**Optional:**
- Subject line
- Phone number

After submitting, you should see a "Thank you" or confirmation message.

### User Registration

**Location:** /register or /signup

Typical registration flow - fill in email, password, confirm password, maybe name.

## Tips & Quirks

- Standard website layout with header, main content, footer
- Search results may load asynchronously - wait for them to appear
- Cookie consent banner might appear on first visit - just accept or dismiss it

## Notes

This is a generic example. Real sites will have their own specific quirks and workflows.


---


## Learned from: "What is this website?"
- Even when targeting a well-known domain like example.com, the automation may report a generic loading error; be prepared to confirm the URL or request an alternative when that happens.
- After encountering a loading failure, taking a screenshot (as the agent did) is useful for documenting the issue before informing the user.

---


## Learned from: "Go to example.com and tell me what you see on the page"

- The page failed to load and returned a browser error; taking a screenshot and grabbing page text helped confirm the failure before reporting it.
- When confronted with an error page, it’s useful to note explicitly that the content couldn’t be accessed rather than guessing, so the user understands the limitation.

---


## Learned from: "Go to example.com and tell me the page title"
- The page title can be captured directly with `get_page_text` after loading https://example.com; there's no need to inspect the page source or alternate domains.
- Navigating to `https://example.com` loads instantly without authentication, so you can retrieve the title immediately after the first `read_page` call for faster completion.