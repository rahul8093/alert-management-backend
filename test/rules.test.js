const test = require('node:test');
const assert = require('node:assert');
const { readingStatus, evaluateDevice } = require('../src/worker/rules');
const { verifyPassword } = require('../src/lib/password');
const time = require('../src/lib/time');
const crypto = require('crypto');

const cfg = { offlineAfterMinutes: 120, maxAgeMinutes: 120, warnRatio: 0.9 };

test('readingStatus uses m_device_setpoint min/max', () => {
  assert.equal(readingStatus(31, 0, 30, 0.9), 'critical'); // BOD above 30
  assert.equal(readingStatus(27, 0, 30, 0.9), 'warning'); // >= 27 is 90 %
  assert.equal(readingStatus(10, 0, 30, 0.9), 'normal');
  assert.equal(readingStatus(5.0, 5.5, 9, 0.9), 'critical'); // pH below 5.5
  assert.equal(readingStatus(9.5, 5.5, 9, 0.9), 'critical'); // pH above 9
  assert.equal(readingStatus(8.1, 5.5, 9, 0.9), 'normal'); // range: warn only in outer 10 % (0.35)
  assert.equal(readingStatus(8.7, 5.5, 9, 0.9), 'warning');
  assert.equal(readingStatus(5.8, 5.5, 9, 0.9), 'warning');
  assert.equal(readingStatus(5.8, null, null, 0.9), 'normal'); // flow_outlet has no limits
  assert.equal(readingStatus(0, 0, 0, 0.9), 'normal');
  assert.equal(readingStatus(null, 0, 30, 0.9), 'nodata');
});

test('evaluateDevice: offline + stale', () => {
  const device = { deviceId: 'ETP_1', params: [{ paramId: 'BOD', name: 'BOD', min: 0, max: 30 }, { paramId: 'pH', name: 'pH', min: 5.5, max: 9 }] };
  const latest = new Map([['BOD', { log_date: '2026-10-28 08:00:00', property_value: 40 }]]);
  let ev = evaluateDevice(device, latest, '2026-10-28 09:00:00', cfg);
  assert.equal(ev.offline, null);
  assert.equal(ev.params[0].status, 'critical');
  assert.equal(ev.params[1].status, 'nodata');
  ev = evaluateDevice(device, latest, '2026-10-28 10:30:00', cfg);
  assert.equal(ev.offline.minutes, 150);
  assert.equal(ev.params[0].status, 'stale');
  ev = evaluateDevice(device, new Map(), '2026-10-28 10:30:00', cfg);
  assert.ok(ev.offline);
});

test('password formats', () => {
  const p = 'Secret@123';
  assert.ok(verifyPassword(p, crypto.createHash('sha256').update(p).digest('hex'), 'auto'));
  assert.ok(verifyPassword(p, crypto.createHash('sha256').update(p).digest('hex').toUpperCase(), 'auto'));
  assert.ok(verifyPassword(p, crypto.createHash('sha1').update(p).digest('base64'), 'auto'));
  assert.ok(!verifyPassword('wrong', crypto.createHash('sha256').update(p).digest('hex'), 'auto'));
  assert.ok(!verifyPassword(p, crypto.createHash('sha1').update(p).digest('base64'), 'sha256'));
});

test('IST time helpers are independent of server timezone', () => {
  assert.equal(time.toLocal(new Date('2026-10-28T05:00:00Z')), '2026-10-28 10:30:00');
  assert.equal(time.fromLocal('2026-10-28 10:30:00').toISOString(), '2026-10-28T05:00:00.000Z');
  assert.equal(time.minutesBetween('2026-10-28 10:00:00', '2026-10-28 12:15:00'), 135);
  assert.equal(time.parseLocalParam('2026-10-27'), '2026-10-27 00:00:00');
  assert.equal(time.parseLocalParam('garbage'), null);
});
