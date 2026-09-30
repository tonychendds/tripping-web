import assert from "node:assert/strict"
import test from "node:test"
import { parseScreenshot } from "./parse-screenshot.js"

const zone = "America/Los_Angeles"

test("EVA BR confirmation with a mangled airline name prefills Bangkok", () => {
  const text = `ANA AIRWAYS - Taipei
- Bangkok
Friday, December
18, 2026
From: To:
TPE BKK
Taiwan Suvarnabhu
Taoyuan Int'l mi Int'l
Taipei, TW Bangkok,
TH
08:45 PM
11:40 PM
Flight BR 205
Number: Operated by
EVA
AIRWAYS
Airline ZX9QK2
Confirmatio
n:
Duration: 03H 55M,
Non-Stop
Aircraft Boeing 787-
Type: 10
Class of Economy
Travel:
Seats: 12A, 12C
Policies:
Free 24 Hour Cancellation: visit
Manage My Trips within 24
hours of booking for a full
refund.`
  const parsed = parseScreenshot(text, zone)
  assert.equal(parsed.trip.city, "Bangkok")
  assert.equal(parsed.trip.country, "Thailand")
  assert.equal(parsed.trip.currency, "THB")
  assert.equal(parsed.trip.timezone, "Asia/Bangkok")
  assert.equal(parsed.trip.startDate, "2026-12-18")
  assert.equal(parsed.trip.endDate, "2026-12-18")
  assert.equal(parsed.trip.title, "Bangkok")
  assert.equal(parsed.item.airline, "EVA Air")
  assert.equal(parsed.item.flightNumber, "BR 205")
  assert.equal(parsed.item.departure.airportCode, "TPE")
  assert.equal(parsed.item.departure.local, "2026-12-18T20:45")
  assert.equal(parsed.item.departure.timezone, "Asia/Taipei")
  assert.equal(parsed.item.arrival.airportCode, "BKK")
  assert.equal(parsed.item.arrival.city, "Bangkok")
  assert.equal(parsed.item.arrival.local, "2026-12-18T23:40")
  assert.equal(parsed.item.arrival.timezone, "Asia/Bangkok")
  assert.equal(parsed.item.cabinClass, "economy")
  assert.equal(parsed.item.seat, "12A, 12C")
  assert.equal(parsed.item.confirmationCode, "ZX9QK2")
  assert.equal(parsed.found[0], "EVA Air BR 205")
  assert.match(parsed.note, /EVA Air BR 205/)
  assert.doesNotMatch(parsed.note, /\bANA\b/)
  assert.notEqual(parsed.trip.country, "Japan")
  assert.notEqual(parsed.trip.currency, "JPY")
})

test("Manage My Trips does not turn BR into ANA or Japan", () => {
  const text = `Flight BR 205
Number: Operated by
EVA
AIRWAYS
Class of Economy
Manage My Trips within 24
hours of booking for a full
refund.`
  const parsed = parseScreenshot(text, zone)
  assert.equal(parsed.item.airline, "EVA Air")
  assert.equal(parsed.item.flightNumber, "BR 205")
  assert.equal(parsed.trip.city, "")
  assert.equal(parsed.trip.country, "")
  assert.equal(parsed.trip.currency, "")
  assert.equal(parsed.found.join(", "), "EVA Air BR 205")
  assert.doesNotMatch(parsed.note, /ANA/)
})

test("arrival airport wins when the word Japan is also in the image", () => {
  const text = `Japan
From: TPE
To: BKK
December 18, 2026
08:45 PM
11:40 PM
Flight BR 205
EVA AIRWAYS`
  const parsed = parseScreenshot(text, zone)
  assert.equal(parsed.trip.city, "Bangkok")
  assert.equal(parsed.trip.country, "Thailand")
  assert.equal(parsed.trip.currency, "THB")
  assert.equal(parsed.trip.timezone, "Asia/Bangkok")
  assert.equal(parsed.item.airline, "EVA Air")
})

test("a real ANA flight number still maps to ANA and Tokyo", () => {
  const text = `ANA
Flight NH 806
From: TPE
10:00 AM
To: HND
December 1, 2026
2:00 PM
Manage My Trips`
  const parsed = parseScreenshot(text, zone)
  assert.equal(parsed.item.airline, "ANA")
  assert.equal(parsed.item.flightNumber, "NH 806")
  assert.equal(parsed.trip.city, "Tokyo")
  assert.equal(parsed.trip.country, "Japan")
  assert.equal(parsed.trip.currency, "JPY")
  assert.equal(parsed.trip.timezone, "Asia/Tokyo")
  assert.equal(parsed.item.arrival.local, "2026-12-01T14:00")
})

test("Bangkok is the destination when the airport code is missed but the To city is not", () => {
  const text = `From: Taipei, TW
To: Bangkok, TH
Friday, December 18, 2026
08:45 PM
11:40 PM
Flight BR 205
EVA AIRWAYS
Manage My Trips`
  const parsed = parseScreenshot(text, zone)
  assert.equal(parsed.trip.city, "Bangkok")
  assert.equal(parsed.trip.country, "Thailand")
  assert.equal(parsed.trip.currency, "THB")
  assert.equal(parsed.trip.timezone, "Asia/Bangkok")
  assert.equal(parsed.item.airline, "EVA Air")
})
