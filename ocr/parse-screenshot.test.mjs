import assert from "node:assert/strict"
import test from "node:test"
import { ianaZones, parseScreenshot, zoneForPlace } from "./parse-screenshot.js"

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

test("Bangkok and Thailand resolve to Asia/Bangkok, and the zone list is the IANA set", () => {
  assert.equal(zoneForPlace("Bangkok", "Thailand"), "Asia/Bangkok")
  assert.equal(zoneForPlace("", "Thailand"), "Asia/Bangkok")
  assert.equal(zoneForPlace("Bangkok", "Japan"), "Asia/Tokyo")
  assert.equal(zoneForPlace("Tokyo", ""), "Asia/Tokyo")
  const zones = ianaZones()
  assert.ok(zones.includes("Asia/Bangkok"))
  assert.ok(zones.includes("Asia/Tokyo"))
  assert.ok(zones.length > 100)
  assert.equal(zones.includes("Ict"), false)
})

test("Alaska confirmation without a year prefills the same-day trip and AS 327", () => {
  const text = `reservations.alaskaair.com
San Diego, CA SAN
Sacramento, CA SMF
1h 41min | Nonstop | 480 miles
AS 327
Operated by Alaska
Check in with Alaska Airlines
Departs
Fri, Dec 11 | 8:14 PM
San Diego, CA
San Diego International Airport
Arrives
Fri, Dec 11 | 9:55 PM
Sacramento, CA
Sacramento Intl.
Saver (X) | No seat(s) selected
For Saver Fare tickets, seats will be assigned at your departure gate.`
  const parsed = parseScreenshot(text, zone, new Date(2026, 8, 30))
  assert.equal(parsed.trip.city, "Sacramento")
  assert.equal(parsed.trip.country, "United States")
  assert.equal(parsed.trip.currency, "USD")
  assert.equal(parsed.trip.timezone, "America/Los_Angeles")
  assert.equal(parsed.trip.startDate, "2026-12-11")
  assert.equal(parsed.trip.endDate, "2026-12-11")
  assert.equal(parsed.item.type, "flight")
  assert.equal(parsed.item.airline, "Alaska Airlines")
  assert.equal(parsed.item.flightNumber, "AS 327")
  assert.equal(parsed.item.departure.airportCode, "SAN")
  assert.equal(parsed.item.departure.city, "San Diego")
  assert.equal(parsed.item.departure.local, "2026-12-11T20:14")
  assert.equal(parsed.item.departure.timezone, "America/Los_Angeles")
  assert.equal(parsed.item.arrival.airportCode, "SMF")
  assert.equal(parsed.item.arrival.city, "Sacramento")
  assert.equal(parsed.item.arrival.local, "2026-12-11T21:55")
  assert.equal(parsed.item.arrival.timezone, "America/Los_Angeles")
  assert.equal(parsed.item.seat, "")
  assert.doesNotMatch(parsed.note, /hotel/i)
})

test("on-device Alaska OCR still prefills dates when the airport codes are misread", () => {
  const text = `San Diego, CAsan >
Sacramento, CA sme
1h 41min | Nonstop | 480 miles
@ AS327
Operated by Alaska
Check in with Alaska Airlines
Departs
Fri, Dec 11| 8:14PM
San Diego, CA
San Diego International Airport
Arrives
Fri, Dec 11| 9:55PM
Sacramento, CA
Sacramento Intl.
Saver (X) | No seat(s) selected
For Saver Fare tickets. seats will be assigned at your departure gate.`
  const parsed = parseScreenshot(text, zone, new Date(2026, 8, 30))
  assert.equal(parsed.trip.startDate, "2026-12-11")
  assert.equal(parsed.trip.endDate, "2026-12-11")
  assert.equal(parsed.item.airline, "Alaska Airlines")
  assert.equal(parsed.item.flightNumber, "AS 327")
  assert.equal(parsed.item.departure.airportCode, "SAN")
  assert.equal(parsed.item.departure.local, "2026-12-11T20:14")
  assert.equal(parsed.item.arrival.airportCode, "SMF")
  assert.equal(parsed.item.arrival.local, "2026-12-11T21:55")
})

test("a month and day that already passed this year uses next year", () => {
  const text = `AS 327
San Diego, CA SAN
Sacramento, CA SMF
Departs
Fri, Dec 11 | 8:14 PM
Arrives
Fri, Dec 11 | 9:55 PM`
  const parsed = parseScreenshot(text, zone, new Date(2026, 11, 12))
  assert.equal(parsed.trip.startDate, "2027-12-11")
  assert.equal(parsed.trip.endDate, "2027-12-11")
  assert.equal(parsed.item.departure.local, "2027-12-11T20:14")
  assert.equal(parsed.item.arrival.local, "2027-12-11T21:55")
})

test("the same calendar day is kept when that month and day is today", () => {
  const text = `AS 327
SAN
SMF
Departs
Fri, Dec 11 | 8:14 PM
Arrives
Fri, Dec 11 | 9:55 PM`
  const parsed = parseScreenshot(text, zone, new Date(2026, 11, 11))
  assert.equal(parsed.trip.startDate, "2026-12-11")
  assert.equal(parsed.trip.endDate, "2026-12-11")
})

test("an arrival in January after a December departure crosses into the next year", () => {
  const text = `AS 50
San Diego, CA SAN
Sacramento, CA SMF
Departs
Mon, Dec 30 | 11:00 PM
Arrives
Sat, Jan 2 | 6:00 AM`
  const parsed = parseScreenshot(text, zone, new Date(2026, 8, 30))
  assert.equal(parsed.trip.startDate, "2026-12-30")
  assert.equal(parsed.trip.endDate, "2027-01-02")
  assert.equal(parsed.item.departure.local, "2026-12-30T23:00")
  assert.equal(parsed.item.arrival.local, "2027-01-02T06:00")
})

test("an explicit year is kept even when that date is in the past", () => {
  const text = `AS 100
SAN SMF
Departs
Fri, December 11, 2020 | 8:14 PM
Arrives
Fri, December 11, 2020 | 9:55 PM`
  const parsed = parseScreenshot(text, zone, new Date(2026, 8, 30))
  assert.equal(parsed.trip.startDate, "2020-12-11")
  assert.equal(parsed.trip.endDate, "2020-12-11")
  assert.equal(parsed.item.departure.local, "2020-12-11T20:14")
  assert.equal(parsed.item.arrival.local, "2020-12-11T21:55")
})

test("a hotel check-in still prefills when the confirmation is a hotel", () => {
  const text = `Hilton Sukhumvit
Bangkok, Thailand
Check-in: December 18, 2026 3:00 PM
Check-out: December 20, 2026 11:00 AM
Confirmation: ABC123`
  const parsed = parseScreenshot(text, zone, new Date(2026, 8, 30))
  assert.equal(parsed.item.type, "lodging")
  assert.equal(parsed.item.name, "Hilton Sukhumvit")
  assert.equal(parsed.trip.city, "Bangkok")
  assert.equal(parsed.trip.country, "Thailand")
  assert.equal(parsed.item.checkIn, "2026-12-18T15:00")
  assert.equal(parsed.item.checkOut, "2026-12-20T11:00")
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
