// Extracting the shared photo behind a Google Maps link (e.g. a
// maps.app.goo.gl share URL). The redirect target's URL carries the photo's
// googleusercontent thumbnail inside its !6s data segment, and
// googleusercontent size suffixes are rewritable — so the same URL serves
// the full-resolution image.

const LINK_HOSTS = new Set([
  'maps.app.goo.gl',
  'goo.gl',
  'www.google.com',
  'google.com',
  'maps.google.com',
])

const IMAGE_HOST_RE = /^lh\d+\.googleusercontent\.com$/

// Accepts only https Google Maps links (short or resolved) and direct
// googleusercontent image URLs — the fetch allowlist against SSRF.
export function isMapsPhotoLink(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && (LINK_HOSTS.has(u.hostname) || IMAGE_HOST_RE.test(u.hostname))
  } catch {
    return false
  }
}

export function isPhotoHost(url) {
  try {
    return IMAGE_HOST_RE.test(new URL(url).hostname)
  } catch {
    return false
  }
}

// Rewrites the size directive after the final "=" (e.g. "=w203-h135-k-no")
// to a large bound; "-k-no" keeps the full frame uncropped.
export function upgradePhotoSize(photoUrl) {
  return photoUrl.replace(/=[-a-z0-9]+$/i, '') + '=w1600-h1600-k-no'
}

// Finds the shared photo's googleusercontent URL in a resolved Maps URL (or
// page HTML as a fallback), upgraded to full size. Contributed place photos
// live under /gps-cs-s/, which is preferred over avatars and map sprites.
export function extractPhotoUrl(text) {
  let haystack = text
  try {
    haystack = decodeURIComponent(text)
  } catch {
    // malformed escapes: search the raw text instead
  }
  const match =
    haystack.match(/https:\/\/lh\d+\.googleusercontent\.com\/gps-cs-s\/[^!?\s"'\\]+/) ??
    haystack.match(/https:\/\/lh\d+\.googleusercontent\.com\/[^!?\s"'\\]+/)
  return match ? upgradePhotoSize(match[0]) : null
}
