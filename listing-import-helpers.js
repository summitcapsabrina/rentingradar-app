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

// The numbers that describe a unit. A price alone doesn't: on a page that isn't a
// listing it can be a search filter or an ad.
function importStructuralCount(data) {
  if (!data) return 0;
  return ['bedrooms', 'bathrooms', 'sqft'].filter((k) => data[k] != null && data[k] !== '').length;
}

// Nothing to save: no unit numbers, no real address, nothing to pick from, whatever
// the price. Same rule as scrapeIsEmpty in the extension.
function isEmptyImport(data) {
  return importStructuralCount(data) === 0 && !isUsableImportAddress(data && data.address) && !importHasUnitChoices(data);
}

const STREET_WORDS = { street: 'st', avenue: 'ave', boulevard: 'blvd', drive: 'dr', road: 'rd', lane: 'ln', court: 'ct', place: 'pl', parkway: 'pkwy', highway: 'hwy', terrace: 'ter', circle: 'cir' };
// One unit prefix: "#", "Unit", "Apt." and so on. Listings stack them ("#Unit 714",
// "Unit #714"), so the patterns below accept any run of them.
const UNIT_PREFIX = '(?:#|(?:apt|apartment|unit|ste|suite|bldg|building|floor|fl)\\b\\.?)';
const UNIT_PREFIXES = UNIT_PREFIX + '(?:\\s*' + UNIT_PREFIX + ')*';
const UNIT_SUFFIX_RE = new RegExp('\\s+' + UNIT_PREFIXES + '\\s*([a-z0-9-]+)\\s*$', 'i');
const UNIT_AFTER_STREET_RE = new RegExp('^,\\s*' + UNIT_PREFIXES + '\\s*([a-z0-9-]+)\\s*(?=,|$)', 'i');
const LEADING_UNIT_PREFIXES_RE = new RegExp('^\\s*' + UNIT_PREFIXES + '\\s*', 'i');

function normalizeStreetForMatch(street) {
  return normalizeAddressForMatch(street).split(' ').map((w) => STREET_WORDS[w] || w).join(' ');
}

function normalizeUnitForMatch(unit) {
  return normalizeAddressForMatch(String(unit == null ? '' : unit).replace(LEADING_UNIT_PREFIXES_RE, ''));
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
  // "8436 Gulf Blvd, Unit 714", with or without more after it.
  const afterStreet = rest.match(UNIT_AFTER_STREET_RE);
  if (!unit && afterStreet) unit = afterStreet[1];
  const zip = (rest.match(/\b(\d{5})(?:-\d{4})?\s*$/) || [])[1] || '';
  return { street: normalizeStreetForMatch(street), unit: normalizeUnitForMatch(unit), zip };
}

// The key as one string for logs: "8436 gulf blvd|714|32566".
function addressKeyText(key) {
  return key ? [key.street, key.unit, key.zip].join('|') : '';
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

// Checks every way this import can name its address (geocoded parts, the one-line
// name, the scraped text); a match on any of them is a duplicate. Returns the match
// (or null) and the key that matched, else the first key, for the import trace.
function importDuplicateCheck(candidates, records) {
  let firstKey = '';
  for (const c of candidates || []) {
    if (!c || isPlaceholderPropertyName(c.name)) continue;
    const key = addressMatchKey(c.addressParts && c.addressParts.street ? c.addressParts : c.name);
    if (!key.street) continue;
    if (!firstKey) firstKey = addressKeyText(key);
    const match = findImportDuplicate(c, records);
    if (match) return { match, key: addressKeyText(key) };
  }
  return { match: null, key: firstKey };
}

const IMPORT_LINK_RE = /(?:^|\/\/|\.)(?:zillow\.com|apartments\.com|hotpads\.com|facebook\.com\/marketplace|craigslist\.org)/i;

// A profile a failed import left behind: a stand-in name, no street, no beds, baths or
// sq ft. A rent alone doesn't save it (a non-listing page's filter price could land
// there), and neither does a missing link. Same rule as isEmptyImport.
function isBlankImportedRecord(r) {
  if (!r || !isPlaceholderPropertyName(r.property)) return false;
  if (r.addressParts && String(r.addressParts.street || '').trim()) return false;
  return importStructuralCount({
    bedrooms: (r.propertyDetails || {}).bedrooms,
    bathrooms: (r.propertyDetails || {}).bathrooms,
    sqft: (r.propertyDetails || {}).sqft,
  }) === 0;
}

// The listing link a blank record came from, or '' when it has none.
function blankImportSourceLink(r) {
  const link = [r && r.link, r && r._aiSourceUrl].map((x) => String(x || '')).find((x) => IMPORT_LINK_RE.test(x));
  return link || '';
}

const GEOCODE_UNIT_PREFIX_WORD = { '#': '#', ste: 'Ste', suite: 'Suite', apt: 'Apt', apartment: 'Apt', bldg: 'Bldg', building: 'Bldg', unit: 'Unit' };

// The unit for a geocoded address, from Places' subpremise and the scraped text.
// Places usually returns the bare number ("714"), so the prefix comes from how the
// listing wrote it, "#" if it didn't. A subpremise that already has a prefix is
// kept as it is, so this never makes "#Unit 714".
function geocodedUnit(subpremise, rawAddress) {
  const sub = String(subpremise || '').trim();
  const raw = typeof rawAddress === 'string' ? rawAddress : '';
  if (sub && /^(?:#|(?:unit|ste|suite|apt|apartment|bldg|building)\b)/i.test(sub)) {
    return sub.replace(/^#\s*(?=[a-z])/i, '').replace(/^(#)\s+/, '$1');
  }
  // The last "<prefixes> <token>" in the text; with stacked prefixes ("#Unit 714")
  // the word wins over "#".
  const re = /((?:(?:#|\b(?:Unit|Suite|Apartment|Building)\b|\b(?:Ste|Apt|Bldg)\b\.?)\s*)+)([A-Za-z0-9][\w-]*)/gi;
  let match, last = null;
  while ((match = re.exec(raw)) !== null) last = match;
  let prefix = '#';
  if (last) {
    const words = last[1].match(/[a-z]+/gi) || [];
    if (words.length) prefix = GEOCODE_UNIT_PREFIX_WORD[words[words.length - 1].toLowerCase()] || '#';
  }
  const token = sub || (last ? last[2] : '');
  if (!token) return '';
  return prefix === '#' ? '#' + token : prefix + ' ' + token;
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
    _chosenPlanName: plan.label || plan.name || null,
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
// A $ figure next to one of these is a charge on top of the rent, not the rent.
const FEE_CONTEXT_RE = /\b(?:fees?|deposits?|packages?|pets?|parking|amenit(?:y|ies)|admin(?:istrative)?|application|utilit(?:y|ies))\b/i;
const RENT_WORD_RE = /\brents?\b/i;
const FIGURE_BOUNDARY_RE = /\$|;|,\s|\.\s/;
// A sentence about other units says nothing about this one's beds and baths.
const OTHER_UNITS_RE = /\balso available\b|\bother\s+(?:units?|floor\s*plans?|plans?|layouts?)\b/i;
const RENT_BAND = [0.5, 2];

function _countValue(raw) {
  const w = raw.toLowerCase();
  if (/^studios?$/.test(w)) return 0;
  return NUMBER_WORDS[w] != null ? NUMBER_WORDS[w] : parseFloat(w);
}

// Removes lists of sizes: "1, 2 and 3 bedroom", "studio to 3 bedroom", "1-2 bath".
// The counts must rise, so "Unit 4 - 3 bedroom" still reads as a 3 bedroom.
function _withoutCountLists(text, unitWords) {
  const item = '(?:studios?|\\d(?:\\.\\d)?|one|two|three|four|five|six)';
  const sep = '\\s*(?:,\\s*(?:and\\s+|or\\s+|&\\s*)?|and\\s+|or\\s+|&\\s*|to\\s+|through\\s+|-|–|—)\\s*';
  const list = new RegExp('(?<![\\d,.$])\\b(' + item + '(?:' + sep + item + ')+)[\\s-]*(?:' + unitWords + ')\\b', 'gi');
  return text.replace(list, (whole, items) => {
    const counts = (items.match(new RegExp(item, 'gi')) || []).map(_countValue);
    return counts.every((n, i) => i === 0 || n > counts[i - 1]) ? ' ' : whole;
  });
}

function _countsIn(text, re) {
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push(_countValue(m[1]));
  return out;
}

// One size in a bullet is a claim about the unit. Two different ones are a list of
// what the building offers ("1 bedroom and 2 bedroom units").
function _unitCounts(text, unitWords) {
  const found = _countsIn(_withoutCountLists(text, unitWords), new RegExp('\\b' + COUNT_PART + '[\\s-]*(?:' + unitWords + ')\\b', 'gi'));
  return new Set(found).size > 1 ? [] : found;
}

// What a bullet says about the unit: { beds:[], baths:[], sqft:[], rent:[] }. Each
// rent entry is the figures of one claim: [1900], or [1900, 2400] for a range.
function bulletFigures(text) {
  const t = String(text == null ? '' : text);
  const aboutOtherUnits = OTHER_UNITS_RE.test(t);
  const beds = aboutOtherUnits ? [] : _unitCounts(t, 'bed(?:room)?s?|bd|br');
  const baths = aboutOtherUnits ? [] : _unitCounts(t, 'bath(?:room)?s?|ba');
  const sqft = [];
  const sqRe = /\b(\d[\d,]*)\s*(?:sq\.?\s*ft\.?|sqft|square\s*f(?:ee|oo)t|sf)(?![a-z])/gi;
  let m;
  while ((m = sqRe.exec(t))) {
    if (!NOT_UNIT_AREA_RE.test(t.slice(m.index + m[0].length, m.index + m[0].length + 40))) sqft.push(parseInt(m[1].replace(/,/g, ''), 10));
  }
  const rent = [];
  const rentRe = /\$\s*(\d[\d,]*)(?:\s*(?:-|–|—|to)\s*\$?\s*(\d[\d,]*))?/gi;
  while ((m = rentRe.exec(t))) {
    const end = m.index + m[0].length;
    const before = t.slice(Math.max(0, m.index - 24), m.index).split(FIGURE_BOUNDARY_RE).pop();
    const after = t.slice(end, end + 16).split(FIGURE_BOUNDARY_RE)[0];
    if (FEE_CONTEXT_RE.test(before) || (FEE_CONTEXT_RE.test(after) && !RENT_WORD_RE.test(before))) continue;
    if (!RENT_CONTEXT_RE.test(before + m[0] + after)) continue;
    const low = parseInt(m[1].replace(/,/g, ''), 10);
    const high = m[2] ? parseInt(m[2].replace(/,/g, ''), 10) : NaN;
    rent.push(high > low ? [low, high] : [low]);
  }
  return { beds, baths, sqft, rent };
}

function _contradicts(found, actual, slack) {
  if (actual == null || actual === '') return false;
  const want = Number(actual);
  if (!Number.isFinite(want)) return false;
  return found.some((n) => Math.abs(n - want) > (slack || 0));
}

// A claim far from the final rent is some other charge, and a range only needs one
// end to match.
function _contradictsRent(claims, actual) {
  if (actual == null || actual === '') return false;
  const want = Number(actual);
  if (!Number.isFinite(want)) return false;
  return claims.some((c) => c.some((n) => n >= want * RENT_BAND[0] && n <= want * RENT_BAND[1]) && !c.includes(want));
}

function _escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Drops note bullets that disagree with the numbers the record ended up with.
// core: { bedrooms, bathrooms, sqft, price }. opts.otherPlanNames: plans that were
// not chosen. opts.chosenPlanName: the plan that was, so "B3" can't match inside
// "B3 Deluxe". opts.blankUnit: no plan was chosen, so bullets may state no unit
// numbers at all. Returns the bullets to keep.
function filterBulletsAgainstCore(bullets, core, opts) {
  const o = opts || {};
  const c = core || {};
  const others = (o.otherPlanNames || []).filter(Boolean).map((n) =>
    new RegExp('(?<![a-z0-9.])' + _escapeRegExp(n) + '(?![a-z0-9]|\\.\\d)', 'i'));
  const chosen = o.chosenPlanName ? new RegExp('(?<![a-z0-9.])' + _escapeRegExp(o.chosenPlanName) + '(?![a-z0-9]|\\.\\d)', 'gi') : null;
  return (Array.isArray(bullets) ? bullets : []).filter((b) => {
    const named = chosen ? String(b).replace(chosen, ' ') : String(b);
    if (others.some((re) => re.test(named))) return false;
    const f = bulletFigures(b);
    if (o.blankUnit) return !(f.beds.length || f.baths.length || f.sqft.length || f.rent.length);
    return !(_contradicts(f.beds, c.bedrooms) || _contradicts(f.baths, c.bathrooms) || _contradicts(f.sqft, c.sqft, 1) || _contradictsRent(f.rent, c.price));
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeAddressForMatch,
    isPlaceholderPropertyName,
    isUsableImportAddress,
    importCoreCount,
    importStructuralCount,
    importHasUnitChoices,
    isEmptyImport,
    addressMatchKey,
    addressKeysMatch,
    findImportDuplicate,
    addressKeyText,
    importDuplicateCheck,
    isBlankImportedRecord,
    blankImportSourceLink,
    geocodedUnit,
    formatPlanLabel,
    applyPlanToListing,
    skipPlanForListing,
    bulletFigures,
    filterBulletsAgainstCore,
  };
}
