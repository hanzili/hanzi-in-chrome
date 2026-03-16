# news.ycombinator.com

*Knowledge file created automatically*

---

### hacker-news-top-stories
*Task: Go to Hacker News and tell me the titles and point counts of the top N stories*

**Required Information:**
- Number of stories to retrieve (e.g., top 1, top 3, top 5)

**Optional Information:**
- None: There are no optional fields for this task.

**Steps:**
1. Navigate to https://news.ycombinator.com/ in a web browser.
2. Observe the ranked list of stories on the homepage.
3. For each of the top N stories:
   - Note the story title text
   - Note the points count (shown in the subtext line below each title)
4. Report the titles and point counts back to the requester.

**Tips:**
- Hacker News is minimalist; the homepage immediately lists stories by rank, so no extra clicks are required.
- Story titles appear as links in the main listing.
- Point counts appear in the line below each title (format: "X points by username").
- You do not need to log in to view stories and their points.
- Multiple `read_page` calls may be needed to extract all story information accurately.
- Stories are numbered sequentially (1, 2, 3, etc.) on the left side of each entry.

---