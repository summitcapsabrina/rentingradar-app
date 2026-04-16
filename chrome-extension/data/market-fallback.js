// Static suburb/city → AirDNA market mapping (fallback when AirDNA is unavailable)
// Market names follow AirDNA's convention: "Primary City, ST"
// Only suburbs that map to a DIFFERENT metro name need entries here;
// cities that ARE the metro primary (e.g. "Phoenix" → "Phoenix, AZ") are
// handled by the default "City, ST" logic in _rrLookupStaticMarket().

/* global self */

const _RR_SUBURB_TO_METRO = {
  // ── New York Metro ──
  'brooklyn|ny':'New York, NY','bronx|ny':'New York, NY','queens|ny':'New York, NY',
  'staten island|ny':'New York, NY','manhattan|ny':'New York, NY',
  'yonkers|ny':'New York, NY','new rochelle|ny':'New York, NY','white plains|ny':'New York, NY',
  'mount vernon|ny':'New York, NY','hempstead|ny':'New York, NY',
  'long beach|ny':'New York, NY','freeport|ny':'New York, NY',
  'jersey city|nj':'New York, NY','newark|nj':'New York, NY','hoboken|nj':'New York, NY',
  'bayonne|nj':'New York, NY','elizabeth|nj':'New York, NY','paterson|nj':'New York, NY',
  'clifton|nj':'New York, NY','passaic|nj':'New York, NY','union city|nj':'New York, NY',
  'west new york|nj':'New York, NY','fort lee|nj':'New York, NY',
  'stamford|ct':'New York, NY','greenwich|ct':'New York, NY','norwalk|ct':'New York, NY',

  // ── Los Angeles Metro ──
  'santa monica|ca':'Los Angeles, CA','venice|ca':'Los Angeles, CA',
  'beverly hills|ca':'Los Angeles, CA','west hollywood|ca':'Los Angeles, CA',
  'culver city|ca':'Los Angeles, CA','inglewood|ca':'Los Angeles, CA',
  'pasadena|ca':'Los Angeles, CA','glendale|ca':'Los Angeles, CA',
  'burbank|ca':'Los Angeles, CA','long beach|ca':'Los Angeles, CA',
  'torrance|ca':'Los Angeles, CA','compton|ca':'Los Angeles, CA',
  'downey|ca':'Los Angeles, CA','el monte|ca':'Los Angeles, CA',
  'pomona|ca':'Los Angeles, CA','anaheim|ca':'Los Angeles, CA',
  'irvine|ca':'Los Angeles, CA','huntington beach|ca':'Los Angeles, CA',
  'costa mesa|ca':'Los Angeles, CA','newport beach|ca':'Los Angeles, CA',
  'laguna beach|ca':'Los Angeles, CA','dana point|ca':'Los Angeles, CA',
  'fullerton|ca':'Los Angeles, CA','santa ana|ca':'Los Angeles, CA',
  'ontario|ca':'Los Angeles, CA','rancho cucamonga|ca':'Los Angeles, CA',
  'claremont|ca':'Los Angeles, CA','whittier|ca':'Los Angeles, CA',

  // ── Chicago Metro ──
  'evanston|il':'Chicago, IL','oak park|il':'Chicago, IL','cicero|il':'Chicago, IL',
  'skokie|il':'Chicago, IL','schaumburg|il':'Chicago, IL','naperville|il':'Chicago, IL',
  'aurora|il':'Chicago, IL','joliet|il':'Chicago, IL','elgin|il':'Chicago, IL',
  'arlington heights|il':'Chicago, IL','bolingbrook|il':'Chicago, IL',
  'gary|in':'Chicago, IL','hammond|in':'Chicago, IL',

  // ── Phoenix Metro ──
  'scottsdale|az':'Phoenix, AZ','tempe|az':'Phoenix, AZ','mesa|az':'Phoenix, AZ',
  'chandler|az':'Phoenix, AZ','gilbert|az':'Phoenix, AZ','glendale|az':'Phoenix, AZ',
  'peoria|az':'Phoenix, AZ','surprise|az':'Phoenix, AZ','goodyear|az':'Phoenix, AZ',
  'avondale|az':'Phoenix, AZ','buckeye|az':'Phoenix, AZ','cave creek|az':'Phoenix, AZ',
  'fountain hills|az':'Phoenix, AZ','paradise valley|az':'Phoenix, AZ',
  'queen creek|az':'Phoenix, AZ',

  // ── Dallas-Fort Worth ──
  'fort worth|tx':'Dallas-Fort Worth, TX','arlington|tx':'Dallas-Fort Worth, TX',
  'plano|tx':'Dallas-Fort Worth, TX','irving|tx':'Dallas-Fort Worth, TX',
  'frisco|tx':'Dallas-Fort Worth, TX','mckinney|tx':'Dallas-Fort Worth, TX',
  'garland|tx':'Dallas-Fort Worth, TX','grand prairie|tx':'Dallas-Fort Worth, TX',
  'denton|tx':'Dallas-Fort Worth, TX','richardson|tx':'Dallas-Fort Worth, TX',
  'allen|tx':'Dallas-Fort Worth, TX','flower mound|tx':'Dallas-Fort Worth, TX',
  'dallas|tx':'Dallas-Fort Worth, TX',

  // ── Houston Metro ──
  'pasadena|tx':'Houston, TX','sugar land|tx':'Houston, TX','pearland|tx':'Houston, TX',
  'league city|tx':'Houston, TX','conroe|tx':'Houston, TX','baytown|tx':'Houston, TX',
  'missouri city|tx':'Houston, TX','the woodlands|tx':'Houston, TX',
  'katy|tx':'Houston, TX','spring|tx':'Houston, TX','humble|tx':'Houston, TX',
  'galveston|tx':'Houston, TX',

  // ── San Francisco Bay Area ──
  'oakland|ca':'San Francisco, CA','berkeley|ca':'San Francisco, CA',
  'san mateo|ca':'San Francisco, CA','daly city|ca':'San Francisco, CA',
  'redwood city|ca':'San Francisco, CA','palo alto|ca':'San Francisco, CA',
  'mountain view|ca':'San Francisco, CA','sunnyvale|ca':'San Francisco, CA',
  'santa clara|ca':'San Francisco, CA','san jose|ca':'San Francisco, CA',
  'fremont|ca':'San Francisco, CA','hayward|ca':'San Francisco, CA',
  'richmond|ca':'San Francisco, CA','walnut creek|ca':'San Francisco, CA',
  'concord|ca':'San Francisco, CA','pleasanton|ca':'San Francisco, CA',
  'sausalito|ca':'San Francisco, CA','tiburon|ca':'San Francisco, CA',
  'mill valley|ca':'San Francisco, CA','san rafael|ca':'San Francisco, CA',

  // ── Miami Metro ──
  'miami beach|fl':'Miami, FL','fort lauderdale|fl':'Miami, FL',
  'hollywood|fl':'Miami, FL','hialeah|fl':'Miami, FL','coral gables|fl':'Miami, FL',
  'boca raton|fl':'Miami, FL','pompano beach|fl':'Miami, FL',
  'deerfield beach|fl':'Miami, FL','delray beach|fl':'Miami, FL',
  'boynton beach|fl':'Miami, FL','aventura|fl':'Miami, FL',
  'sunny isles beach|fl':'Miami, FL','key biscayne|fl':'Miami, FL',
  'coconut grove|fl':'Miami, FL','wynwood|fl':'Miami, FL',
  'west palm beach|fl':'Miami, FL','palm beach|fl':'Miami, FL',

  // ── Washington DC Metro ──
  'arlington|va':'Washington, DC','alexandria|va':'Washington, DC',
  'fairfax|va':'Washington, DC','reston|va':'Washington, DC',
  'tysons|va':'Washington, DC','mclean|va':'Washington, DC',
  'bethesda|md':'Washington, DC','silver spring|md':'Washington, DC',
  'rockville|md':'Washington, DC','college park|md':'Washington, DC',
  'bowie|md':'Washington, DC','gaithersburg|md':'Washington, DC',
  'washington|dc':'Washington, DC',

  // ── Boston Metro ──
  'cambridge|ma':'Boston, MA','somerville|ma':'Boston, MA','brookline|ma':'Boston, MA',
  'newton|ma':'Boston, MA','quincy|ma':'Boston, MA','waltham|ma':'Boston, MA',
  'medford|ma':'Boston, MA','malden|ma':'Boston, MA','revere|ma':'Boston, MA',
  'salem|ma':'Boston, MA','lynn|ma':'Boston, MA',

  // ── Seattle Metro ──
  'bellevue|wa':'Seattle, WA','kirkland|wa':'Seattle, WA','redmond|wa':'Seattle, WA',
  'renton|wa':'Seattle, WA','kent|wa':'Seattle, WA','tacoma|wa':'Seattle, WA',
  'everett|wa':'Seattle, WA','bothell|wa':'Seattle, WA','issaquah|wa':'Seattle, WA',
  'burien|wa':'Seattle, WA','shoreline|wa':'Seattle, WA',

  // ── Denver Metro ──
  'aurora|co':'Denver, CO','lakewood|co':'Denver, CO','arvada|co':'Denver, CO',
  'westminster|co':'Denver, CO','thornton|co':'Denver, CO','centennial|co':'Denver, CO',
  'boulder|co':'Denver, CO','littleton|co':'Denver, CO','englewood|co':'Denver, CO',
  'golden|co':'Denver, CO','broomfield|co':'Denver, CO','commerce city|co':'Denver, CO',
  'castle rock|co':'Denver, CO','parker|co':'Denver, CO',

  // ── Atlanta Metro ──
  'decatur|ga':'Atlanta, GA','marietta|ga':'Atlanta, GA','roswell|ga':'Atlanta, GA',
  'sandy springs|ga':'Atlanta, GA','alpharetta|ga':'Atlanta, GA',
  'johns creek|ga':'Atlanta, GA','kennesaw|ga':'Atlanta, GA',
  'smyrna|ga':'Atlanta, GA','dunwoody|ga':'Atlanta, GA',
  'buckhead|ga':'Atlanta, GA','brookhaven|ga':'Atlanta, GA',

  // ── Minneapolis-St. Paul ──
  'st. paul|mn':'Minneapolis, MN','saint paul|mn':'Minneapolis, MN',
  'bloomington|mn':'Minneapolis, MN','plymouth|mn':'Minneapolis, MN',
  'brooklyn park|mn':'Minneapolis, MN','eagan|mn':'Minneapolis, MN',
  'eden prairie|mn':'Minneapolis, MN','burnsville|mn':'Minneapolis, MN',
  'maple grove|mn':'Minneapolis, MN','woodbury|mn':'Minneapolis, MN',

  // ── Tampa Bay ──
  'st. petersburg|fl':'Tampa, FL','saint petersburg|fl':'Tampa, FL',
  'clearwater|fl':'Tampa, FL','brandon|fl':'Tampa, FL','largo|fl':'Tampa, FL',
  'dunedin|fl':'Tampa, FL','palm harbor|fl':'Tampa, FL',
  'new port richey|fl':'Tampa, FL','plant city|fl':'Tampa, FL',

  // ── Orlando Metro ──
  'kissimmee|fl':'Orlando, FL','sanford|fl':'Orlando, FL',
  'winter park|fl':'Orlando, FL','lake buena vista|fl':'Orlando, FL',
  'celebration|fl':'Orlando, FL','daytona beach|fl':'Orlando, FL',
  'altamonte springs|fl':'Orlando, FL','ocoee|fl':'Orlando, FL',

  // ── San Diego Metro ──
  'chula vista|ca':'San Diego, CA','carlsbad|ca':'San Diego, CA',
  'oceanside|ca':'San Diego, CA','escondido|ca':'San Diego, CA',
  'vista|ca':'San Diego, CA','encinitas|ca':'San Diego, CA',
  'la jolla|ca':'San Diego, CA','del mar|ca':'San Diego, CA',
  'coronado|ca':'San Diego, CA','national city|ca':'San Diego, CA',

  // ── Portland Metro ──
  'beaverton|or':'Portland, OR','hillsboro|or':'Portland, OR',
  'gresham|or':'Portland, OR','lake oswego|or':'Portland, OR',
  'tigard|or':'Portland, OR','tualatin|or':'Portland, OR',
  'milwaukie|or':'Portland, OR','oregon city|or':'Portland, OR',
  'vancouver|wa':'Portland, OR','clackamas|or':'Portland, OR',

  // ── Las Vegas Metro ──
  'henderson|nv':'Las Vegas, NV','north las vegas|nv':'Las Vegas, NV',
  'summerlin|nv':'Las Vegas, NV','spring valley|nv':'Las Vegas, NV',
  'paradise|nv':'Las Vegas, NV','enterprise|nv':'Las Vegas, NV',
  'boulder city|nv':'Las Vegas, NV',

  // ── Nashville Metro ──
  'franklin|tn':'Nashville, TN','murfreesboro|tn':'Nashville, TN',
  'brentwood|tn':'Nashville, TN','hendersonville|tn':'Nashville, TN',
  'gallatin|tn':'Nashville, TN','mt. juliet|tn':'Nashville, TN',
  'mount juliet|tn':'Nashville, TN','smyrna|tn':'Nashville, TN',
  'lebanon|tn':'Nashville, TN',

  // ── Austin Metro ──
  'round rock|tx':'Austin, TX','cedar park|tx':'Austin, TX',
  'pflugerville|tx':'Austin, TX','georgetown|tx':'Austin, TX',
  'san marcos|tx':'Austin, TX','kyle|tx':'Austin, TX',
  'lakeway|tx':'Austin, TX','leander|tx':'Austin, TX','dripping springs|tx':'Austin, TX',

  // ── San Antonio Metro ──
  'new braunfels|tx':'San Antonio, TX','boerne|tx':'San Antonio, TX',
  'schertz|tx':'San Antonio, TX','cibolo|tx':'San Antonio, TX',
  'universal city|tx':'San Antonio, TX','live oak|tx':'San Antonio, TX',
  'selma|tx':'San Antonio, TX',

  // ── Philadelphia Metro ──
  'chester|pa':'Philadelphia, PA','norristown|pa':'Philadelphia, PA',
  'king of prussia|pa':'Philadelphia, PA','conshohocken|pa':'Philadelphia, PA',
  'media|pa':'Philadelphia, PA','ardmore|pa':'Philadelphia, PA',
  'cherry hill|nj':'Philadelphia, PA','camden|nj':'Philadelphia, PA',
  'wilmington|de':'Philadelphia, PA',

  // ── Baltimore Metro ──
  'towson|md':'Baltimore, MD','columbia|md':'Baltimore, MD',
  'ellicott city|md':'Baltimore, MD','catonsville|md':'Baltimore, MD',
  'owings mills|md':'Baltimore, MD','annapolis|md':'Baltimore, MD',
  'glen burnie|md':'Baltimore, MD',

  // ── Charlotte Metro ──
  'huntersville|nc':'Charlotte, NC','cornelius|nc':'Charlotte, NC',
  'davidson|nc':'Charlotte, NC','concord|nc':'Charlotte, NC',
  'gastonia|nc':'Charlotte, NC','mooresville|nc':'Charlotte, NC',
  'matthews|nc':'Charlotte, NC','mint hill|nc':'Charlotte, NC',
  'indian trail|nc':'Charlotte, NC','rock hill|sc':'Charlotte, NC',
  'fort mill|sc':'Charlotte, NC',

  // ── Raleigh-Durham ──
  'durham|nc':'Raleigh, NC','chapel hill|nc':'Raleigh, NC',
  'cary|nc':'Raleigh, NC','apex|nc':'Raleigh, NC',
  'morrisville|nc':'Raleigh, NC','wake forest|nc':'Raleigh, NC',
  'holly springs|nc':'Raleigh, NC','garner|nc':'Raleigh, NC',
  'fuquay-varina|nc':'Raleigh, NC',

  // ── Detroit Metro ──
  'dearborn|mi':'Detroit, MI','livonia|mi':'Detroit, MI','troy|mi':'Detroit, MI',
  'royal oak|mi':'Detroit, MI','ferndale|mi':'Detroit, MI',
  'ann arbor|mi':'Detroit, MI','sterling heights|mi':'Detroit, MI',
  'warren|mi':'Detroit, MI','southfield|mi':'Detroit, MI',
  'birmingham|mi':'Detroit, MI','rochester hills|mi':'Detroit, MI',

  // ── Cleveland Metro ──
  'lakewood|oh':'Cleveland, OH','parma|oh':'Cleveland, OH',
  'shaker heights|oh':'Cleveland, OH','cleveland heights|oh':'Cleveland, OH',
  'euclid|oh':'Cleveland, OH','strongsville|oh':'Cleveland, OH',
  'westlake|oh':'Cleveland, OH','medina|oh':'Cleveland, OH',

  // ── St. Louis Metro ──
  'clayton|mo':'St. Louis, MO','university city|mo':'St. Louis, MO',
  'kirkwood|mo':'St. Louis, MO','webster groves|mo':'St. Louis, MO',
  "o'fallon|mo":'St. Louis, MO','chesterfield|mo':'St. Louis, MO',
  'st. charles|mo':'St. Louis, MO','saint charles|mo':'St. Louis, MO',
  'florissant|mo':'St. Louis, MO',

  // ── Kansas City Metro ──
  'overland park|ks':'Kansas City, MO','olathe|ks':'Kansas City, MO',
  'shawnee|ks':'Kansas City, MO','lenexa|ks':'Kansas City, MO',
  'leawood|ks':'Kansas City, MO','prairie village|ks':'Kansas City, MO',
  'independence|mo':'Kansas City, MO',"lee's summit|mo":'Kansas City, MO',
  'blue springs|mo':'Kansas City, MO','liberty|mo':'Kansas City, MO',

  // ── Cincinnati Metro ──
  'covington|ky':'Cincinnati, OH','newport|ky':'Cincinnati, OH',
  'florence|ky':'Cincinnati, OH','mason|oh':'Cincinnati, OH',
  'west chester|oh':'Cincinnati, OH','fairfield|oh':'Cincinnati, OH',
  'hamilton|oh':'Cincinnati, OH','norwood|oh':'Cincinnati, OH',

  // ── Pittsburgh Metro ──
  'cranberry township|pa':'Pittsburgh, PA','bethel park|pa':'Pittsburgh, PA',
  'mount lebanon|pa':'Pittsburgh, PA','monroeville|pa':'Pittsburgh, PA',
  'north hills|pa':'Pittsburgh, PA','ross township|pa':'Pittsburgh, PA',
  'robinson township|pa':'Pittsburgh, PA',

  // ── Indianapolis Metro ──
  'carmel|in':'Indianapolis, IN','fishers|in':'Indianapolis, IN',
  'noblesville|in':'Indianapolis, IN','greenwood|in':'Indianapolis, IN',
  'zionsville|in':'Indianapolis, IN','westfield|in':'Indianapolis, IN',
  'brownsburg|in':'Indianapolis, IN','avon|in':'Indianapolis, IN',
  'plainfield|in':'Indianapolis, IN',

  // ── Columbus Metro ──
  'dublin|oh':'Columbus, OH','westerville|oh':'Columbus, OH',
  'upper arlington|oh':'Columbus, OH','hilliard|oh':'Columbus, OH',
  'grove city|oh':'Columbus, OH','gahanna|oh':'Columbus, OH',
  'reynoldsburg|oh':'Columbus, OH','powell|oh':'Columbus, OH',
  'new albany|oh':'Columbus, OH','delaware|oh':'Columbus, OH',

  // ── Salt Lake City Metro ──
  'west jordan|ut':'Salt Lake City, UT','sandy|ut':'Salt Lake City, UT',
  'murray|ut':'Salt Lake City, UT','south jordan|ut':'Salt Lake City, UT',
  'draper|ut':'Salt Lake City, UT','park city|ut':'Salt Lake City, UT',
  'provo|ut':'Salt Lake City, UT','orem|ut':'Salt Lake City, UT',
  'lehi|ut':'Salt Lake City, UT','american fork|ut':'Salt Lake City, UT',
  'bountiful|ut':'Salt Lake City, UT','ogden|ut':'Salt Lake City, UT',

  // ── Sacramento Metro ──
  'elk grove|ca':'Sacramento, CA','roseville|ca':'Sacramento, CA',
  'folsom|ca':'Sacramento, CA','rancho cordova|ca':'Sacramento, CA',
  'citrus heights|ca':'Sacramento, CA','davis|ca':'Sacramento, CA',
  'woodland|ca':'Sacramento, CA',

  // ── New Orleans Metro ──
  'metairie|la':'New Orleans, LA','kenner|la':'New Orleans, LA',
  'harvey|la':'New Orleans, LA','gretna|la':'New Orleans, LA',
  'slidell|la':'New Orleans, LA','mandeville|la':'New Orleans, LA',
  'covington|la':'New Orleans, LA',

  // ── Vacation / Resort Markets ──
  // Outer Banks, NC
  'kill devil hills|nc':'Outer Banks, NC','kitty hawk|nc':'Outer Banks, NC',
  'nags head|nc':'Outer Banks, NC','duck|nc':'Outer Banks, NC',
  'corolla|nc':'Outer Banks, NC','manteo|nc':'Outer Banks, NC',
  // Destin / Panama City Beach
  'destin|fl':'Destin, FL','miramar beach|fl':'Destin, FL',
  'santa rosa beach|fl':'Destin, FL','panama city beach|fl':'Panama City Beach, FL',
  '30a|fl':'Destin, FL',
  // Smoky Mountains
  'gatlinburg|tn':'Smoky Mountains, TN','pigeon forge|tn':'Smoky Mountains, TN',
  'sevierville|tn':'Smoky Mountains, TN','townsend|tn':'Smoky Mountains, TN',
  'bryson city|nc':'Smoky Mountains, TN',
  // Blue Ridge / North GA Mountains
  'blue ridge|ga':'Blue Ridge, GA','ellijay|ga':'Blue Ridge, GA',
  'cherry log|ga':'Blue Ridge, GA','helen|ga':'Blue Ridge, GA',
  // Poconos
  'pocono pines|pa':'Poconos, PA','tannersville|pa':'Poconos, PA',
  'mount pocono|pa':'Poconos, PA','stroudsburg|pa':'Poconos, PA',
  'east stroudsburg|pa':'Poconos, PA','tobyhanna|pa':'Poconos, PA',
  'bushkill|pa':'Poconos, PA','long pond|pa':'Poconos, PA',
  // Big Bear / Lake Arrowhead
  'big bear lake|ca':'Big Bear, CA','big bear city|ca':'Big Bear, CA',
  'lake arrowhead|ca':'Big Bear, CA','running springs|ca':'Big Bear, CA',
  // Gulf Shores
  'gulf shores|al':'Gulf Shores, AL','orange beach|al':'Gulf Shores, AL',
  'fort morgan|al':'Gulf Shores, AL','perdido key|fl':'Gulf Shores, AL',
  // Myrtle Beach
  'myrtle beach|sc':'Myrtle Beach, SC','north myrtle beach|sc':'Myrtle Beach, SC',
  'surfside beach|sc':'Myrtle Beach, SC','pawleys island|sc':'Myrtle Beach, SC',
  'garden city|sc':'Myrtle Beach, SC',
  // Cape Cod
  'provincetown|ma':'Cape Cod, MA','chatham|ma':'Cape Cod, MA',
  'hyannis|ma':'Cape Cod, MA','falmouth|ma':'Cape Cod, MA',
  'barnstable|ma':'Cape Cod, MA','harwich|ma':'Cape Cod, MA',
  'orleans|ma':'Cape Cod, MA','wellfleet|ma':'Cape Cod, MA',
  'truro|ma':'Cape Cod, MA','brewster|ma':'Cape Cod, MA',
  'dennis|ma':'Cape Cod, MA','sandwich|ma':'Cape Cod, MA',
  // Lake Tahoe
  'south lake tahoe|ca':'Lake Tahoe, CA','tahoe city|ca':'Lake Tahoe, CA',
  'truckee|ca':'Lake Tahoe, CA','kings beach|ca':'Lake Tahoe, CA',
  'incline village|nv':'Lake Tahoe, CA','stateline|nv':'Lake Tahoe, CA',
  // Sedona
  'sedona|az':'Sedona, AZ','cottonwood|az':'Sedona, AZ',
  'camp verde|az':'Sedona, AZ','village of oak creek|az':'Sedona, AZ',
  // Joshua Tree / Palm Springs
  'joshua tree|ca':'Joshua Tree, CA','twentynine palms|ca':'Joshua Tree, CA',
  'yucca valley|ca':'Joshua Tree, CA',
  'palm springs|ca':'Palm Springs, CA','palm desert|ca':'Palm Springs, CA',
  'rancho mirage|ca':'Palm Springs, CA','indian wells|ca':'Palm Springs, CA',
  'la quinta|ca':'Palm Springs, CA','cathedral city|ca':'Palm Springs, CA',
  'indio|ca':'Palm Springs, CA',
  // Hawaii
  'kailua-kona|hi':'Big Island, HI','kailua kona|hi':'Big Island, HI',
  'hilo|hi':'Big Island, HI','captain cook|hi':'Big Island, HI',
  'waikoloa|hi':'Big Island, HI',
  'lahaina|hi':'Maui, HI','kihei|hi':'Maui, HI','wailea|hi':'Maui, HI',
  'kahului|hi':'Maui, HI','paia|hi':'Maui, HI','haiku|hi':'Maui, HI',
  'wailuku|hi':'Maui, HI','makawao|hi':'Maui, HI',
  'kapaa|hi':'Kauai, HI','lihue|hi':'Kauai, HI','poipu|hi':'Kauai, HI',
  'princeville|hi':'Kauai, HI','koloa|hi':'Kauai, HI','hanalei|hi':'Kauai, HI',
  'honolulu|hi':'Honolulu, HI','waikiki|hi':'Honolulu, HI',
  'kailua|hi':'Honolulu, HI','kaneohe|hi':'Honolulu, HI',
  // Savannah
  'tybee island|ga':'Savannah, GA',
  // Charleston
  'mount pleasant|sc':'Charleston, SC','north charleston|sc':'Charleston, SC',
  'folly beach|sc':'Charleston, SC','isle of palms|sc':'Charleston, SC',
  "sullivan's island|sc":'Charleston, SC','james island|sc':'Charleston, SC',
  'summerville|sc':'Charleston, SC','kiawah island|sc':'Charleston, SC',
  // Key West / Florida Keys
  'key west|fl':'Florida Keys, FL','key largo|fl':'Florida Keys, FL',
  'islamorada|fl':'Florida Keys, FL','marathon|fl':'Florida Keys, FL',
  'big pine key|fl':'Florida Keys, FL','duck key|fl':'Florida Keys, FL',
  'tavernier|fl':'Florida Keys, FL',
  // Hilton Head
  'hilton head island|sc':'Hilton Head, SC','hilton head|sc':'Hilton Head, SC',
  'bluffton|sc':'Hilton Head, SC',
  // Branson
  'branson|mo':'Branson, MO','hollister|mo':'Branson, MO',
  'kimberling city|mo':'Branson, MO','indian point|mo':'Branson, MO',
  // Wine Country
  'napa|ca':'Napa Valley, CA','st. helena|ca':'Napa Valley, CA',
  'saint helena|ca':'Napa Valley, CA','calistoga|ca':'Napa Valley, CA',
  'yountville|ca':'Napa Valley, CA',
  'sonoma|ca':'Sonoma, CA','healdsburg|ca':'Sonoma, CA',
  'petaluma|ca':'Sonoma, CA','sebastopol|ca':'Sonoma, CA',
  'guerneville|ca':'Sonoma, CA',
  // Aspen / Colorado Mountains
  'aspen|co':'Aspen, CO','snowmass|co':'Aspen, CO',
  'snowmass village|co':'Aspen, CO','basalt|co':'Aspen, CO',
  'breckenridge|co':'Breckenridge, CO','dillon|co':'Breckenridge, CO',
  'silverthorne|co':'Breckenridge, CO','frisco|co':'Breckenridge, CO',
  'keystone|co':'Breckenridge, CO',
  'vail|co':'Vail, CO','avon|co':'Vail, CO','eagle|co':'Vail, CO',
  'beaver creek|co':'Vail, CO','minturn|co':'Vail, CO',
  'steamboat springs|co':'Steamboat Springs, CO',
  'telluride|co':'Telluride, CO','mountain village|co':'Telluride, CO',
  'winter park|co':'Winter Park, CO','granby|co':'Winter Park, CO',
  'estes park|co':'Estes Park, CO',
  // Scottsdale standalone (AirDNA sometimes treats as separate)
  // Already mapped to Phoenix above
};

/**
 * Look up market/submarket from geocoded city + state.
 * Returns { market, submarket, source }.
 */
function _rrLookupStaticMarket(city, state) {
  if (!city) return { market: null, submarket: null, source: 'none' };
  const key = (city + '|' + state).toLowerCase().trim();
  const metro = _RR_SUBURB_TO_METRO[key];
  if (metro) {
    return { market: metro, submarket: city, source: 'suburb-mapping' };
  }
  // City is likely a primary metro itself — format as "City, ST"
  const market = city + ', ' + (state || '').toUpperCase();
  return { market: market, submarket: city, source: 'geocode-primary' };
}

// Expose for importScripts() in service worker
if (typeof self !== 'undefined') {
  self._rrLookupStaticMarket = _rrLookupStaticMarket;
}
