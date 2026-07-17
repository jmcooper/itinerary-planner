import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isMapsPhotoLink,
  isPhotoHost,
  upgradePhotoSize,
  extractPhotoUrl,
} from '../src/mapsphoto.js'

// The actual resolved URL behind a maps.app.goo.gl photo share (trimmed).
const RESOLVED =
  'https://www.google.com/maps/place/Excelsior+Geyser+Crater/@44.5262413,-110.8370334,3a,75y,90t/data=!3m8!1e2!3m6!1sCIHM0ogKEICAgICCivia4gE!2e10!3e12!6shttps:%2F%2Flh3.googleusercontent.com%2Fgps-cs-s%2FAHRPTWlAmkbfDMfwNr8%3Dw203-h135-k-no!7i2560!8i1707!4m7!3m6!1s0x5351ebb9332bbdc3:0x67f7cdbac99203ca'

test('isMapsPhotoLink allows Google Maps and googleusercontent https URLs only', () => {
  assert.equal(isMapsPhotoLink('https://maps.app.goo.gl/7WKTEzkFLmjssVTRA'), true)
  assert.equal(isMapsPhotoLink('https://www.google.com/maps/place/X'), true)
  assert.equal(isMapsPhotoLink('https://lh3.googleusercontent.com/gps-cs-s/ABC=w203-h135-k-no'), true)
  assert.equal(isMapsPhotoLink('http://maps.app.goo.gl/x'), false) // not https
  assert.equal(isMapsPhotoLink('https://evil.example/maps.app.goo.gl'), false)
  assert.equal(isMapsPhotoLink('https://notgoogleusercontent.com/x'), false)
  assert.equal(isMapsPhotoLink('not a url'), false)
})

test('isPhotoHost distinguishes direct image URLs', () => {
  assert.equal(isPhotoHost('https://lh3.googleusercontent.com/gps-cs-s/ABC=w203'), true)
  assert.equal(isPhotoHost('https://maps.app.goo.gl/x'), false)
})

test('upgradePhotoSize rewrites the trailing size directive', () => {
  assert.equal(
    upgradePhotoSize('https://lh3.googleusercontent.com/gps-cs-s/ABC=w203-h135-k-no'),
    'https://lh3.googleusercontent.com/gps-cs-s/ABC=w1600-h1600-k-no'
  )
  assert.equal(
    upgradePhotoSize('https://lh5.googleusercontent.com/p/XYZ=s400'),
    'https://lh5.googleusercontent.com/p/XYZ=w1600-h1600-k-no'
  )
})

test('extractPhotoUrl pulls the !6s photo out of a resolved maps URL, upgraded', () => {
  assert.equal(
    extractPhotoUrl(RESOLVED),
    'https://lh3.googleusercontent.com/gps-cs-s/AHRPTWlAmkbfDMfwNr8=w1600-h1600-k-no'
  )
})

test('extractPhotoUrl prefers contributed photos over other googleusercontent URLs', () => {
  const html =
    'avatar https://lh3.googleusercontent.com/a-/profilepic=s64 and photo https://lh3.googleusercontent.com/gps-cs-s/REALPHOTO=w203-h135-k-no'
  assert.equal(
    extractPhotoUrl(html),
    'https://lh3.googleusercontent.com/gps-cs-s/REALPHOTO=w1600-h1600-k-no'
  )
})

test('extractPhotoUrl returns null when no photo is present', () => {
  assert.equal(extractPhotoUrl('https://www.google.com/maps/place/Nowhere'), null)
})
