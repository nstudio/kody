const { productName } = require('./package.json')

const name = productName || 'Kody'
const distinct = name !== 'Kody'

// Shown over the website so a side-by-side build is never mistaken for the published app. Pure CSS on the root
// element: it survives the site's own rendering and never touches its DOM or event handling.
const badgeCss = `html::after {
	content: ${JSON.stringify(name)};
	position: fixed;
	right: 12px;
	bottom: 12px;
	z-index: 2147483647;
	pointer-events: none;
	padding: 4px 10px;
	border-radius: 999px;
	font: 600 11px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
	letter-spacing: 0.02em;
	color: #fff;
	background: linear-gradient(135deg, #3a53ff, #65adf1);
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
}`

function brandWindow(window) {
	if (!distinct) return
	window.on('page-title-updated', (event, title) => {
		event.preventDefault()
		window.setTitle(title && title !== name ? `${title} — ${name}` : name)
	})
	window.webContents.on('dom-ready', () => {
		window.webContents.insertCSS(badgeCss).catch(() => {})
	})
}

module.exports = { name, distinct, brandWindow }
