const fetch = require("node-fetch")
const sanitizeHTML = require("sanitize-html")
const uniqBy = require("lodash/uniqBy")
const { AssetCache } = require("@11ty/eleventy-cache-assets")

// Load .env variables with dotenv
require("dotenv").config()
const TOKEN = process.env.WEBMENTION_IO_TOKEN

const absoluteURL = (url, domain) => {
	try {
		return new URL(url, domain).toString()
	} catch (e) {
		console.log(`Trying to convert ${url} to be an absolute url with base ${domain} and failed.`)
		return url
	}
}

const baseUrl = (url) => {
	let hashSplit = url.split("#")
	let queryparamSplit = hashSplit[0].split("?")
	return queryparamSplit[0]
}

const fixUrl = (url, urlReplacements) => {
	return Object.entries(urlReplacements).reduce((accumulator, [key, value]) => {
		const regex = new RegExp(key, "g")
		return accumulator.replace(regex, value)
	}, url)
}

const hostname = (value) => {
	if (typeof value === "string" && value.includes("//")) {
		const urlObject = new URL(value)
		return urlObject.hostname
	}
	return value
}

const epoch = (value) => {
	return new Date(value).getTime()
}

module.exports = (config, options = {}) => {
	options = Object.assign(
		{
			duration: "23h",
			key: "webmentions",
			allowedHTML: {
				allowedTags: ["b", "i", "em", "strong", "a"],
				allowedAttributes: {
					a: ["href"],
				},
			},
			urlReplacements: [],
			maximumHtmlLength: 2000,
		},
		options
	)

	const fetchWebmentions = async () => {
		let asset = new AssetCache(options.key)
		asset.ensureDir()

		let webmentions = {
			type: "feed",
			name: "Webmentions",
			children: [],
		}

		// If there is a cached file at all, grab its contents now
		if (asset.isCacheValid("9001y")) {
			webmentions = await asset.getCachedValue()
		}

		// If there is a cached file but it is outside of expiry, fetch fresh
		// results since the most recent
		if (!asset.isCacheValid(options.duration)) {
			const since = asset._cache.getKey(options.key) ? asset._cache.getKey(options.key).cachedAt : false
			const url = `https://webmention.io/api/mentions.jf2?domain=${hostname(options.domain)}&token=${TOKEN}&per-page=9001${since ? `&since=${since}` : ``}`
			const response = await fetch(url)
			if (response.ok) {
				const feed = await response.json()
				if (feed.children.length) {
					console.log(`[${hostname(options.domain)}] ${feed.children.length} new Webmentions fetched into cache.`)
				}
				webmentions.children = [...feed.children, ...webmentions.children].sort((a, b) => {
					return epoch(b.published || b["wm-received"]) - epoch(a.published || a["wm-received"])
				})
				await asset.save(webmentions, "json")
				return webmentions
			}
		}

		return webmentions
	}

	const filteredWebmentions = async () => {
		const rawWebmentions = await fetchWebmentions()
		let webmentions = {}

		// Sort Webmentions into groups by target
		rawWebmentions.children.forEach((webmention) => {
			// Get the target of the Webmention and fix it up
			let url = baseUrl(fixUrl(webmention["wm-target"].replace(/\/?$/, "/"), options.urlReplacements))

			if (!webmentions[url]) {
				webmentions[url] = []
			}

			webmentions[url].push(webmention)
		})

		// Sort Webmentions in groups by url and remove duplicates by wm-id
		for (let url in webmentions) {
			webmentions[url] = uniqBy(webmentions[url], (item) => {
				return item["wm-id"]
			})
		}

		return webmentions
	}

	const getWebmentions = async (url, allowedTypes) => {
		const webmentions = await filteredWebmentions()
		url = absoluteURL(url, options.domain)

		if (!url || !webmentions || !webmentions[url]) {
			return []
		}

		const results = webmentions[url]
			// filter webmentions by allowedTypes only if passed
			.filter((entry) => {
				return Array.isArray(allowedTypes) ? allowedTypes.includes(entry["wm-property"]) : true
			})
			// remove webmentions without an author name
			.filter((entry) => {
				const { author } = entry
				return !!author && !!author.name
			})
			// sanitize content of webmentions and check against HTML limit
			.map((entry) => {
				if (!("content" in entry)) {
					return entry
				}
				const { html, text } = entry.content
				if (html && html.length > options.maximumHtmlLength) {
					entry.content.value = `mentioned this in <a href="${entry["wm-source"]}">${entry["wm-source"]}</a>`
				} else {
					entry.content.value = sanitizeHTML(html || text, options.allowedHTML)
				}
				return entry
			})
			// sort by published/wm-received
			.sort((a, b) => {
				return epoch(a.published || a["wm-received"]) - epoch(b.published || b["wm-received"])
			})

		return results
	}

	const getWebmentionsFilter = async (url, allowedTypes, callback) => {
		const webmentions = await getWebmentions(url, allowedTypes)
		if (typeof callback === "function") {
			callback(null, webmentions)
		} else {
			return webmentions
		}
	}

	if (config && options) {
		if (!options.domain) {
			throw new Error("domain is a required option to be passed when adding the plugin to your config using addPlugin.")
		}

		config.addNunjucksAsyncFilter("getWebmentions", getWebmentionsFilter)
	} else {
		return filteredWebmentions()
	}
}
