// Pure helpers for listing import. Loaded by index.html as plain globals and
// required by tests/listing-import-helpers.test.js under node --test.
// Nothing in this file may touch the DOM, Firestore, or chrome.* APIs.

function normalizeAddressForMatch(str) {
  if (!str) return '';
  return String(str).toLowerCase().replace(/[.,#\-]/g, ' ').replace(/\s+/g, ' ').trim();
}

const PLACEHOLDER_PROPERTY_NAMES = new Set(['new property', 'new co-hosting property', 'single unit', 'multi unit']);

// A name that isn't an address: empty, a stand-in label, or a page title with no
// street number ("Altura at Perdido Key | Apartments.com").
function isPlaceholderPropertyName(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s || PLACEHOLDER_PROPERTY_NAMES.has(s.toLowerCase())) return true;
  return !/^\d+[a-z]?\s+\S/i.test(s);
}

// Same test the extension uses: a street number and some letters.
function isUsableImportAddress(address) {
  const s = String(address == null ? '' : address).trim();
  return /\d/.test(s) && /[a-z]{2}/i.test(s) && !/^\$/.test(s);
}

function importCoreCount(data) {
  if (!data) return 0;
  return ['bedrooms', 'bathrooms', 'sqft', 'price'].filter((k) => data[k] != null && data[k] !== '').length;
}

function importHasUnitChoices(data) {
  return !!data && ((Array.isArray(data.floorplans) && data.floorplans.length > 0) || (Array.isArray(data.units) && data.units.length > 0));
}

// Nothing to save: no numbers, no real address, nothing to pick from.
function isEmptyImport(data) {
  return importCoreCount(data) === 0 && !isUsableImportAddress(data && data.address) && !importHasUnitChoices(data);
}

const STREET_WORDS = { street: 'st', avenue: 'ave', boulevard: 'blvd', drive: 'dr', road: 'rd', lane: 'ln', court: 'ct', place: 'pl', parkway: 'pkwy', highway: 'hwy', terrace: 'ter', circle: 'cir' };
const UNIT_SUFFIX_RE = /\s+(?:#|(?:apt|apartment|unit|ste|suite|bldg|building|floor|fl)\b\.?)\s*#?\s*([a-z0-9-]+)\s*$/i;

function normalizeStreetForMatch(street) {
  return normalizeAddressForMatch(street).split(' ').map((w) => STREET_WORDS[w] || w).join(' ');
}

function normalizeUnitForMatch(unit) {
  return normalizeAddressForMatch(String(unit == null ? '' : unit).replace(/^\s*(?:#|(?:apt|apartment|unit|ste|suite|bldg|building|floor|fl)\b\.?)\s*#?/i, ''));
}

// { street, unit, zip } for comparing addresses, from an addressParts object or a
// one-line address ("8522 Gulf Blvd APT 4, Navarre FL 32566").
function addressMatchKey(address) {
  if (address && typeof address === 'object') {
    let street = String(address.street || '');
    let unit = address.unit || '';
    if (!unit) {
      const inStreet = street.match(UNIT_SUFFIX_RE);
      if (inStreet) { unit = inStreet[1]; street = street.slice(0, inStreet.index); }
    }
    return { street: normalizeStreetForMatch(street), unit: normalizeUnitForMatch(unit), zip: String(address.zip || '').trim().slice(0, 5) };
  }
  const s = String(address == null ? '' : address).trim();
  const comma = s.indexOf(',');
  let street = comma >= 0 ? s.slice(0, comma) : s;
  const rest = comma >= 0 ? s.slice(comma) : '';
  let unit = '';
  const inStreet = street.match(UNIT_SUFFIX_RE);
  if (inStreet) { unit = inStreet[1]; street = street.slice(0, inStreet.index); }
  const afterStreet = rest.match(/^,\s*(?:#|(?:apt|apartment|unit|ste|suite)\b\.?)\s*([a-z0-9-]+)\s*(?=,)/i);
  if (!unit && afterStreet) unit = afterStreet[1];
  const zip = (rest.match(/\b(\d{5})(?:-\d{4})?\s*$/) || [])[1] || '';
  return { street: normalizeStreetForMatch(street), unit: normalizeUnitForMatch(unit), zip };
}

function addressKeysMatch(a, b) {
  if (!a || !b || !a.street || !b.street) return false;
  if (a.street !== b.street || a.unit !== b.unit) return false;
  return !a.zip || !b.zip || a.zip === b.zip;
}

// The existing record this import duplicates, compared on street + unit + zip.
// A placeholder name on either side never counts: a blank "New Property" isn't an
// address, so two of them say nothing about each other.
function findImportDuplicate(candidate, records) {
  const name = candidate && candidate.name;
  if (isPlaceholderPropertyName(name)) return null;
  const parts = candidate.addressParts;
  const key = addressMatchKey(parts && parts.street ? parts : name);
  if (!key.street) return null;
  for (const r of (Array.isArray(records) ? records : [])) {
    if (!r || isPlaceholderPropertyName(r.property)) continue;
    const other = addressMatchKey(r.addressParts && r.addressParts.street ? r.addressParts : r.property);
    if (addressKeysMatch(key, other)) return r;
  }
  return null;
}

const IMPORT_LINK_RE = /(?:^|\/\/|\.)(?:zillow\.com|apartments\.com|hotpads\.com|facebook\.com\/marketplace|craigslist\.org)/i;

// A profile a failed import left behind: no address, no numbers, an import link.
function isBlankImportedRecord(r) {
  if (!r || !isPlaceholderPropertyName(r.property)) return false;
  if (r.addressParts && String(r.addressParts.street || '').trim()) return false;
  const d = r.propertyDetails || {};
  if (['bedrooms', 'bathrooms', 'sqft', 'monthlyRent'].some((k) => d[k] != null && d[k] !== '')) return false;
  return IMPORT_LINK_RE.test(String(r.link || '')) || IMPORT_LINK_RE.test(String(r._aiSourceUrl || ''));
}

function _planMoney(n) { return '$' + Number(n).toLocaleString('en-US'); }

// "B4 · 2 bd · 2 ba · 1,193 sf · from $1,991"
function formatPlanLabel(plan) {
  if (!plan) return '';
  const parts = [plan.label || plan.name || 'Floor plan'];
  if (plan.beds != null) parts.push(plan.beds === 0 ? 'Studio' : plan.beds + ' bd');
  if (plan.baths != null) parts.push(plan.baths + ' ba');
  if (plan.sqft != null) parts.push(Number(plan.sqft).toLocaleString('en-US') + ' sf');
  if (plan.priceMin != null) {
    const from = plan.priceFrom || (plan.priceMax != null && plan.priceMax > plan.priceMin);
    parts.push((from ? 'from ' : '') + _planMoney(plan.priceMin));
  }
  return parts.join(' · ');
}

function _planNames(data, exceptName) {
  return (data.floorplans || []).map((p) => p.name).concat((data.units || []).map((u) => u.label))
    .filter((n) => n && n !== exceptName);
}

// The import with one plan's numbers filled in. All four come from that plan.
function applyPlanToListing(data, plan) {
  const out = Object.assign({}, data, {
    bedrooms: plan.beds != null ? plan.beds : null,
    bathrooms: plan.baths != null ? plan.baths : null,
    sqft: plan.sqft != null ? plan.sqft : null,
    price: plan.priceMin != null ? plan.priceMin : null,
    _otherPlanNames: _planNames(data, plan.label || plan.name),
  });
  // A Zillow unit has its own number and listing page; a floor plan has neither.
  if (plan.label) {
    const unit = String(plan.label).replace(/^unit\s+/i, '');
    if (out.address && unit) out.address = String(out.address).replace(/,/, ' #' + unit + ',');
    if (plan.url) out.sourceUrl = plan.url;
  }
  delete out._needsUnit;
  delete out._needsFloorplan;
  delete out.floorplans;
  delete out.units;
  return out;
}

// The import with the unit fields left blank on purpose.
function skipPlanForListing(data) {
  const out = Object.assign({}, data, {
    bedrooms: null, bathrooms: null, sqft: null, price: null,
    _planSkipped: true,
    _otherPlanNames: _planNames(data),
  });
  delete out.floorplans;
  delete out.units;
  return out;
}

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const COUNT_PART = '(\\d+(?:\\.\\d+)?|one|two|three|four|five|six)';
const NOT_UNIT_AREA_RE = /^\s*(?:of\s+)?(?:[a-z-]+\s+){0,2}(?:clubhouse|fitness|gym|lot|pool|amenit|retail|office|lobby|community|park|deck|center|courtyard)/i;
const RENT_CONTEXT_RE = /\b(?:rent|rents|rental|monthly|per month|\/\s*mo|a month|starting|from|priced|price|asking)\b/i;

function _countsIn(text, re) {
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1].toLowerCase();
    out.push(NUMBER_WORDS[raw] != null ? NUMBER_WORDS[raw] : parseFloat(raw));
  }
  return out;
}

// What a bullet says about the unit: { beds:[], baths:[], sqft:[], rent:[] }.
function bulletFigures(text) {
  const t = String(text == null ? '' : text);
  const beds = _countsIn(t, new RegExp('\\b' + COUNT_PART + '[\\s-]*(?:bed(?:room)?s?|bd|br)\\b', 'gi'));
  const baths = _countsIn(t, new RegExp('\\b' + COUNT_PART + '[\\s-]*(?:bath(?:room)?s?|ba)\\b', 'gi'));
  const sqft = [];
  const sqRe = /\b(\d[\d,]*)\s*(?:sq\.?\s*ft\.?|sqft|square\s*f(?:ee|oo)t|sf)(?![a-z])/gi;
  let m;
  while ((m = sqRe.exec(t))) {
    if (!NOT_UNIT_AREA_RE.test(t.slice(m.index + m[0].length, m.index + m[0].length + 40))) sqft.push(parseInt(m[1].replace(/,/g, ''), 10));
  }
  const rent = [];
  const rentRe = /\$\s*(\d[\d,]*)/g;
  while ((m = rentRe.exec(t))) {
    const around = t.slice(Math.max(0, m.index - 24), m.index + m[0].length + 16);
    if (RENT_CONTEXT_RE.test(around)) rent.push(parseInt(m[1].replace(/,/g, ''), 10));
  }
  return { beds, baths, sqft, rent };
}

function _contradicts(found, actual, slack) {
  if (actual == null || actual === '') return false;
  const want = Number(actual);
  if (!Number.isFinite(want)) return false;
  return found.some((n) => Math.abs(n - want) > (slack || 0));
}

// Drops note bullets that disagree with the numbers the record ended up with.
// core: { bedrooms, bathrooms, sqft, price }. opts.otherPlanNames: plans that were
// not chosen. opts.blankUnit: no plan was chosen, so bullets may state no unit
// numbers at all. Returns the bullets to keep.
function filterBulletsAgainstCore(bullets, core, opts) {
  const o = opts || {};
  const c = core || {};
  const others = (o.otherPlanNames || []).filter(Boolean).map((n) =>
    new RegExp('(?<![a-z0-9.])' + String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9])', 'i'));
  return (Array.isArray(bullets) ? bullets : []).filter((b) => {
    if (others.some((re) => re.test(String(b)))) return false;
    const f = bulletFigures(b);
    if (o.blankUnit) return !(f.beds.length || f.baths.length || f.sqft.length || f.rent.length);
    return !(_contradicts(f.beds, c.bedrooms) || _contradicts(f.baths, c.bathrooms) || _contradicts(f.sqft, c.sqft, 1) || _contradicts(f.rent, c.price));
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeAddressForMatch,
    isPlaceholderPropertyName,
    isUsableImportAddress,
    importCoreCount,
    importHasUnitChoices,
    isEmptyImport,
    addressMatchKey,
    addressKeysMatch,
    findImportDuplicate,
    isBlankImportedRecord,
    formatPlanLabel,
    applyPlanToListing,
    skipPlanForListing,
    bulletFigures,
    filterBulletsAgainstCore,
  };
}
