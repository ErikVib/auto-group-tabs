# Auto Group Tabs

Automatically organize your browser tabs into groups based on URL patterns. Keep your browser tidy without manual tab management!

## Features

- 🎯 **Automatic grouping** - Tabs are automatically grouped when they match your URL patterns
- 🎨 **Color coding** - Choose different colors for different groups
- 🔄 **Dynamic ungrouping** - Tabs are ungrouped when navigating to URLs that don't match any pattern
- ⚡ **Simple interface** - Click the extension icon to manage rules instantly
- 🔍 **Wildcard patterns** - Use `*` to match any part of a URL

## Installation

### From Source
1. Clone or download this repository
2. Open Firefox and navigate to `about:debugging`
3. Click "This Firefox" → "Load Temporary Add-on"
4. Select the `manifest.json` file from the extension directory

### From Firefox Add-ons (Coming Soon)
*(Once published to Firefox Add-ons store)*

## Usage

### Adding a Rule
1. Click the extension icon in your toolbar
2. Fill in the form:
   - **Group name**: A friendly name for the group (e.g., "Work", "Social Media")
   - **Pattern**: URL pattern with wildcards (e.g., `*.github.com/*`, `*google.com*`)
   - **Color**: Choose a color for the tab group
3. Click "Add Rule"

### Pattern Examples
- `*.github.com/*` - Matches all GitHub pages
- `*reddit.com*` - Matches Reddit and any subdomain
- `*youtube.com/watch*` - Matches YouTube video pages
- `*.google.com/*` - Matches all Google services

## How It Works

When you navigate to a new URL or update a tab:
- The extension checks if the URL matches any of your configured patterns
- If it matches, the tab is added to the corresponding group (creating the group if needed)
- If it doesn't match any pattern and the tab is in a group, it's ungrouped

## Privacy

This extension:
- ✅ Works entirely locally - no data is sent anywhere
- ✅ Only accesses tab URLs to match patterns
- ✅ Stores rules in your browser's local storage
- ✅ No tracking, analytics, or external requests

## Compatibility

- **Firefox**: Version 89+ (requires Tab Groups API support)

## Contributing

Contributions are welcome! Feel free to:
- Report bugs
- Suggest features
- Submit pull requests

## License

MIT License - See LICENSE file for details

## Support

If you encounter issues or have questions, please file an issue on the GitHub repository.
