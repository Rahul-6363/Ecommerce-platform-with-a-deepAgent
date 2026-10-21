/**
 * Seed data.
 *
 * The catalogue is tagged with transliterated Hindi, Kannada and Tamil words
 * alongside English, which is what lets the keyword retrieval path work when no
 * model is available — "sasta joota" finds cheap shoes with nothing but a regex.
 *
 * The policies are the real substance here: `checkEntitlement` is only as good
 * as the clauses it can cite, and every clause carries the tags the engine
 * matches on.
 */

export const SELLERS = [
  { sellerId: "SEL-01", name: "Bharat Footwear Co.", city: "Agra", ratingAvg: 4.1, defectRatePct: 6, fulfilmentSlaDays: 3 },
  { sellerId: "SEL-02", name: "Nexus Electronics", city: "Bengaluru", ratingAvg: 4.4, defectRatePct: 3, fulfilmentSlaDays: 2 },
  { sellerId: "SEL-03", name: "Kanchi Textiles", city: "Kanchipuram", ratingAvg: 4.6, defectRatePct: 2, fulfilmentSlaDays: 4 },
  { sellerId: "SEL-04", name: "Deccan Home Essentials", city: "Hyderabad", ratingAvg: 3.8, defectRatePct: 11, fulfilmentSlaDays: 5 },
  { sellerId: "SEL-05", name: "Ganga Kitchenware", city: "Kanpur", ratingAvg: 4.0, defectRatePct: 7, fulfilmentSlaDays: 3 },
  { sellerId: "SEL-06", name: "Vedic Wellness", city: "Pune", ratingAvg: 4.2, defectRatePct: 4, fulfilmentSlaDays: 3 },

  /* Competing sellers. These exist so a comparison has something to compare:
   * the same SKU listed at different prices, dispatch speeds and defect
   * rates. The contrast is deliberate — SEL-07 undercuts everyone and fails
   * nearly a fifth of its orders, which is precisely the case a sticker price
   * cannot express and `trueCost` can. */
  { sellerId: "SEL-07", name: "Metro Discount Mart", city: "Surat", ratingAvg: 3.4, defectRatePct: 18, fulfilmentSlaDays: 6 },
  { sellerId: "SEL-08", name: "Prime Fulfilled Depot", city: "Bhiwandi", ratingAvg: 4.7, defectRatePct: 1, fulfilmentSlaDays: 1 },
  { sellerId: "SEL-09", name: "Sunrise Traders", city: "Jaipur", ratingAvg: 4.0, defectRatePct: 8, fulfilmentSlaDays: 4 },
];

/**
 * Competing offers on SKUs that already exist in the catalogue.
 *
 * Read the pressure cooker rows together: Metro is ₹1,499 against Ganga's
 * ₹1,649 and Prime's ₹1,719. On the sticker Metro wins by ₹150. Counting an
 * 18% defect rate and a 6-day dispatch, it loses — and the buyer can see the
 * arithmetic rather than being told the answer.
 */
export const OFFERS = [
  // Pressure cooker — the headline comparison.
  { sku: "VJ-KITCH-501", sellerId: "SEL-07", priceInr: 1499, stock: 30, codEligible: true, fulfilmentSlaDays: 6 },
  { sku: "VJ-KITCH-501", sellerId: "SEL-08", priceInr: 1719, stock: 45, codEligible: true, fulfilmentSlaDays: 1 },
  { sku: "VJ-KITCH-501", sellerId: "SEL-09", priceInr: 1599, stock: 12, codEligible: false, fulfilmentSlaDays: 4 },

  // Running shoes.
  { sku: "VJ-SHOE-101", sellerId: "SEL-07", priceInr: 1699, stock: 22, codEligible: true, fulfilmentSlaDays: 6 },
  { sku: "VJ-SHOE-101", sellerId: "SEL-08", priceInr: 1999, stock: 60, codEligible: true, fulfilmentSlaDays: 1 },

  // Earbuds.
  { sku: "VJ-ELEC-201", sellerId: "SEL-07", priceInr: 2199, stock: 18, codEligible: true, fulfilmentSlaDays: 6 },
  { sku: "VJ-ELEC-201", sellerId: "SEL-08", priceInr: 2649, stock: 80, codEligible: true, fulfilmentSlaDays: 1 },
  { sku: "VJ-ELEC-201", sellerId: "SEL-09", priceInr: 2399, stock: 25, codEligible: true, fulfilmentSlaDays: 4 },

  // Mixer grinder.
  { sku: "VJ-KITCH-502", sellerId: "SEL-08", priceInr: 2899, stock: 20, codEligible: true, fulfilmentSlaDays: 1 },
  { sku: "VJ-KITCH-502", sellerId: "SEL-07", priceInr: 2599, stock: 8, codEligible: true, fulfilmentSlaDays: 6 },

  // Power bank.
  { sku: "VJ-ELEC-202", sellerId: "SEL-09", priceInr: 1699, stock: 40, codEligible: true, fulfilmentSlaDays: 4 },
  { sku: "VJ-ELEC-202", sellerId: "SEL-08", priceInr: 1899, stock: 55, codEligible: true, fulfilmentSlaDays: 1 },

  // Insulated bottle.
  { sku: "VJ-KITCH-503", sellerId: "SEL-07", priceInr: 629, stock: 50, codEligible: true, fulfilmentSlaDays: 6 },
  { sku: "VJ-KITCH-503", sellerId: "SEL-08", priceInr: 749, stock: 90, codEligible: true, fulfilmentSlaDays: 1 },

  // Bedsheet.
  { sku: "VJ-HOME-401", sellerId: "SEL-09", priceInr: 1049, stock: 30, codEligible: true, fulfilmentSlaDays: 4 },

  // Kurta.
  { sku: "VJ-APP-302", sellerId: "SEL-07", priceInr: 699, stock: 35, codEligible: true, fulfilmentSlaDays: 6 },

  // Laptop -- a dear item, so the true-cost gap between sellers is largest here.
  { sku: "VJ-ELEC-206", sellerId: "SEL-07", priceInr: 37499, stock: 6, codEligible: false, fulfilmentSlaDays: 6 },
  { sku: "VJ-ELEC-206", sellerId: "SEL-08", priceInr: 39999, stock: 11, codEligible: false, fulfilmentSlaDays: 1 },

  // Mobile phone.
  { sku: "VJ-ELEC-207", sellerId: "SEL-07", priceInr: 13999, stock: 9, codEligible: true, fulfilmentSlaDays: 6 },
  { sku: "VJ-ELEC-207", sellerId: "SEL-08", priceInr: 14999, stock: 24, codEligible: true, fulfilmentSlaDays: 1 },
  { sku: "VJ-ELEC-207", sellerId: "SEL-09", priceInr: 14249, stock: 15, codEligible: false, fulfilmentSlaDays: 4 },

  // Headphones.
  { sku: "VJ-ELEC-208", sellerId: "SEL-08", priceInr: 2999, stock: 40, codEligible: true, fulfilmentSlaDays: 1 },
  { sku: "VJ-ELEC-208", sellerId: "SEL-09", priceInr: 2649, stock: 17, codEligible: true, fulfilmentSlaDays: 4 },

  // Rice cooker.
  { sku: "VJ-KITCH-506", sellerId: "SEL-07", priceInr: 1549, stock: 20, codEligible: true, fulfilmentSlaDays: 6 },
  { sku: "VJ-KITCH-506", sellerId: "SEL-08", priceInr: 1799, stock: 33, codEligible: true, fulfilmentSlaDays: 1 },

  // Electric kettle.
  { sku: "VJ-KITCH-507", sellerId: "SEL-08", priceInr: 949, stock: 70, codEligible: true, fulfilmentSlaDays: 1 },

  // Winter jacket.
  { sku: "VJ-APP-304", sellerId: "SEL-07", priceInr: 1749, stock: 12, codEligible: true, fulfilmentSlaDays: 6 },

  // Backpack.
  { sku: "VJ-HOME-403", sellerId: "SEL-09", priceInr: 1099, stock: 28, codEligible: true, fulfilmentSlaDays: 4 },

  // Towels.
  { sku: "VJ-HOME-405", sellerId: "SEL-08", priceInr: 799, stock: 60, codEligible: true, fulfilmentSlaDays: 1 },
];

export const POLICIES = [
  {
    policyId: "VJ-ELEC",
    category: "electronics",
    returnWindowDays: 7,
    replacementAllowed: true,
    refundSlaDays: 7,
    lateCompensation: true,
    clauses: [
      { id: "VJ-ELEC-1.1", text: "Electronics may be returned or replaced within 7 days of delivery. The window is counted from the delivery scan recorded by the courier, not from the date of order.", tags: ["window", "return", "replacement", "electronics"] },
      { id: "VJ-ELEC-2.1", text: "An electronic item found non-functional on arrival is replaced within 7 days of delivery. Where replacement stock is unavailable, a full refund is issued within 7 working days of pickup.", tags: ["doa", "replacement", "full_refund", "electronics"] },
      { id: "VJ-ELEC-2.2", text: "An item damaged in transit qualifies for a free replacement on submission of a photograph showing the damage to the item or its packaging.", tags: ["damaged", "replacement", "photo", "electronics"] },
      { id: "VJ-ELEC-2.3", text: "Where an incorrect model, capacity or colour has been shipped, Vaanijya arranges free pickup and dispatches the correct item as a replacement.", tags: ["wrong_item", "replacement", "electronics"] },
      { id: "VJ-ELEC-2.4", text: "If an accessory listed in the box contents is absent, the buyer may claim a part shipment of that accessory, or a partial refund of 15% of the order value.", tags: ["missing_part", "part_shipment", "partial_refund", "electronics"] },
      { id: "VJ-ELEC-2.5", text: "An item established to be counterfeit or not of the advertised brand is refunded in full. The return window is doubled for counterfeit claims, no pickup is required, the item is retained as evidence and the listing is referred to the platform trust team.", tags: ["counterfeit", "full_refund", "electronics"] },
      { id: "VJ-ELEC-2.6", text: "An item that functions correctly but differs materially from the published listing is refunded in full on return.", tags: ["not_as_described", "full_refund", "electronics"] },
      { id: "VJ-ELEC-3.1", text: "A parcel not delivered by the promised date plus a two-day grace period is treated as undelivered. The buyer may request a reshipment, or a full refund where no stock remains.", tags: ["not_delivered", "reship", "full_refund", "window"] },
      { id: "VJ-ELEC-4.1", text: "Where delivery is completed after the promised date, store credit of 5% of the order value, capped at Rs 200, is granted on request.", tags: ["late", "store_credit", "electronics"] },
    ],
  },
  {
    policyId: "VJ-FOOT",
    category: "footwear",
    returnWindowDays: 14,
    replacementAllowed: true,
    refundSlaDays: 5,
    lateCompensation: true,
    clauses: [
      { id: "VJ-FOOT-1.1", text: "Footwear may be returned or exchanged within 14 days of delivery provided the item is unworn and the original packaging is intact.", tags: ["window", "return", "replacement", "footwear"] },
      { id: "VJ-FOOT-2.1", text: "Footwear delivered in a size other than the size ordered is exchanged free of charge, including both pickup and redelivery.", tags: ["wrong_item", "replacement", "footwear"] },
      { id: "VJ-FOOT-2.2", text: "Footwear with a manufacturing defect such as sole separation, a broken strap or a torn upper is replaced on submission of a photograph.", tags: ["damaged", "doa", "replacement", "photo", "footwear"] },
      { id: "VJ-FOOT-2.3", text: "Where one shoe of a pair is absent from the consignment, a part shipment of the missing shoe is dispatched, or a partial refund of 15% is issued.", tags: ["missing_part", "part_shipment", "partial_refund", "footwear"] },
      { id: "VJ-FOOT-2.4", text: "Footwear established to be counterfeit is refunded in full and the return window is doubled.", tags: ["counterfeit", "full_refund", "footwear"] },
      { id: "VJ-FOOT-2.5", text: "Footwear that differs materially in colour, material or finish from the published listing is refunded in full.", tags: ["not_as_described", "full_refund", "footwear"] },
      { id: "VJ-FOOT-3.1", text: "A footwear parcel not delivered by the promised date plus two days is treated as undelivered and reshipped, or refunded in full where no stock remains.", tags: ["not_delivered", "reship", "full_refund", "window"] },
      { id: "VJ-FOOT-4.1", text: "Delivery completed after the promised date attracts store credit of 5% of the order value, capped at Rs 200.", tags: ["late", "store_credit", "footwear"] },
    ],
  },
  {
    policyId: "VJ-APP",
    category: "apparel",
    returnWindowDays: 14,
    replacementAllowed: true,
    refundSlaDays: 5,
    lateCompensation: false,
    clauses: [
      { id: "VJ-APP-1.1", text: "Apparel may be returned within 14 days of delivery with tags attached and the garment unworn and unwashed.", tags: ["window", "return", "replacement", "apparel"] },
      { id: "VJ-APP-2.1", text: "A garment delivered in the wrong size, colour or design is exchanged free of charge.", tags: ["wrong_item", "replacement", "apparel"] },
      { id: "VJ-APP-2.2", text: "A garment arriving torn, stained or with a seam or zip defect is replaced on submission of a photograph.", tags: ["damaged", "doa", "replacement", "photo", "apparel"] },
      { id: "VJ-APP-2.3", text: "Where a set is advertised with multiple pieces and a piece is absent, a part shipment of that piece is dispatched, or a partial refund of 15% is issued.", tags: ["missing_part", "part_shipment", "partial_refund", "apparel"] },
      { id: "VJ-APP-2.4", text: "A garment established not to be of the advertised brand is refunded in full and the return window is doubled.", tags: ["counterfeit", "full_refund", "apparel"] },
      { id: "VJ-APP-2.5", text: "A garment differing materially in fabric, colour or cut from the published listing is refunded in full.", tags: ["not_as_described", "full_refund", "apparel"] },
      { id: "VJ-APP-3.1", text: "An apparel parcel undelivered by the promised date plus two days is reshipped, or refunded in full where no stock remains.", tags: ["not_delivered", "reship", "full_refund", "window"] },
    ],
  },
  {
    policyId: "VJ-HOME",
    category: "home",
    returnWindowDays: 10,
    replacementAllowed: true,
    refundSlaDays: 7,
    lateCompensation: false,
    clauses: [
      { id: "VJ-HOME-1.1", text: "Home furnishing may be returned within 10 days of delivery in its original packaging.", tags: ["window", "return", "replacement", "home"] },
      { id: "VJ-HOME-2.1", text: "A home item arriving cracked, torn, dented or otherwise damaged is replaced on submission of a photograph of the damage.", tags: ["damaged", "doa", "replacement", "photo", "home"] },
      { id: "VJ-HOME-2.2", text: "Where the item delivered is not the item ordered, Vaanijya arranges pickup and dispatches the correct item.", tags: ["wrong_item", "replacement", "home"] },
      { id: "VJ-HOME-2.3", text: "Where fittings or components listed in the box contents are absent, a part shipment is dispatched, or a partial refund of 15% is issued.", tags: ["missing_part", "part_shipment", "partial_refund", "home"] },
      { id: "VJ-HOME-2.4", text: "A home item established to be counterfeit is refunded in full with the return window doubled.", tags: ["counterfeit", "full_refund", "home"] },
      { id: "VJ-HOME-2.5", text: "A home item materially different from the published listing in size, material or colour is refunded in full.", tags: ["not_as_described", "full_refund", "home"] },
      { id: "VJ-HOME-3.1", text: "A home parcel undelivered by the promised date plus two days is reshipped, or refunded in full where stock has been exhausted.", tags: ["not_delivered", "reship", "full_refund", "window"] },
    ],
  },
  {
    policyId: "VJ-KITCH",
    category: "kitchen",
    returnWindowDays: 10,
    replacementAllowed: true,
    refundSlaDays: 7,
    lateCompensation: false,
    clauses: [
      { id: "VJ-KITCH-1.1", text: "Kitchenware may be returned within 10 days of delivery, unused and in its original packaging.", tags: ["window", "return", "replacement", "kitchen"] },
      { id: "VJ-KITCH-2.1", text: "Kitchenware arriving dented, cracked, leaking or with a damaged handle or gasket is replaced on submission of a photograph.", tags: ["damaged", "doa", "replacement", "photo", "kitchen"] },
      { id: "VJ-KITCH-2.2", text: "An appliance that does not power on or does not function as specified is replaced within the return window, or refunded in full where no stock remains.", tags: ["doa", "replacement", "full_refund", "kitchen"] },
      { id: "VJ-KITCH-2.3", text: "Where the model or capacity delivered differs from the model ordered, the correct item is dispatched as a replacement.", tags: ["wrong_item", "replacement", "kitchen"] },
      { id: "VJ-KITCH-2.4", text: "Where a lid, gasket, jar or accessory listed in the box contents is absent, a part shipment is dispatched, or a partial refund of 15% is issued.", tags: ["missing_part", "part_shipment", "partial_refund", "kitchen"] },
      { id: "VJ-KITCH-2.5", text: "Kitchenware established to be counterfeit is refunded in full with the return window doubled.", tags: ["counterfeit", "full_refund", "kitchen"] },
      { id: "VJ-KITCH-2.6", text: "Kitchenware materially different from the published listing is refunded in full.", tags: ["not_as_described", "full_refund", "kitchen"] },
      { id: "VJ-KITCH-3.1", text: "A kitchenware parcel undelivered by the promised date plus two days is reshipped, or refunded in full where no stock remains.", tags: ["not_delivered", "reship", "full_refund", "window"] },
    ],
  },
  {
    policyId: "VJ-BEAUTY",
    category: "beauty",
    returnWindowDays: 7,
    replacementAllowed: false,
    refundSlaDays: 5,
    lateCompensation: false,
    clauses: [
      { id: "VJ-BEAUTY-1.1", text: "Beauty and personal care items may be returned within 7 days of delivery only if the factory seal is unbroken. Replacement is not offered on this category for hygiene reasons; an eligible claim is refunded.", tags: ["window", "return", "beauty"] },
      { id: "VJ-BEAUTY-2.1", text: "A beauty item arriving leaking, broken or with a damaged seal is refunded in full on submission of a photograph.", tags: ["damaged", "doa", "full_refund", "photo", "beauty"] },
      { id: "VJ-BEAUTY-2.2", text: "Where the variant, shade or volume delivered differs from the item ordered, a full refund is issued.", tags: ["wrong_item", "full_refund", "beauty"] },
      { id: "VJ-BEAUTY-2.3", text: "Where an applicator or component listed in the box contents is absent, a partial refund of 15% is issued.", tags: ["missing_part", "partial_refund", "beauty"] },
      { id: "VJ-BEAUTY-2.4", text: "A beauty item established to be counterfeit is refunded in full and the return window is doubled. Counterfeit cosmetics are referred to the platform trust team as a safety matter.", tags: ["counterfeit", "full_refund", "beauty"] },
      { id: "VJ-BEAUTY-2.5", text: "A beauty item materially different from the published listing is refunded in full.", tags: ["not_as_described", "full_refund", "beauty"] },
      { id: "VJ-BEAUTY-3.1", text: "A beauty parcel undelivered by the promised date plus two days is reshipped, or refunded in full.", tags: ["not_delivered", "reship", "full_refund", "window"] },
    ],
  },
];

export const PRODUCTS = [
  // ── Footwear ────────────────────────────────────────────────────────
  {
    sku: "VJ-SHOE-101", title: "Stride Pro Running Shoes", brand: "Stride",
    category: "footwear", subcategory: "running shoes",
    description: "Lightweight mesh running shoes with a cushioned EVA midsole and reflective heel. Built for daily road running on Indian tarmac.",
    attributes: { sizes: "6-11", colour: "Navy/Lime", closure: "Lace-up", weight_g: 260, use: "running" },
    tags: ["shoe", "shoes", "running", "sports", "joota", "jute", "sneaker", "daudna", "ಓಡುವ", "ಶೂ", "ஓட்டம்", "காலணி", "दौड़ना", "जूता", "sasta"],
    solves: ["running", "jogging", "daily exercise", "morning walk", "gym", "marathon training", "sports", "fitness", "lose weight", "roz daudna", "walking long distance"],
    priceInr: 1899, mrpInr: 3499, ratingAvg: 4.3, ratingCount: 2841, stock: 48,
    sellerId: "SEL-01", policyId: "VJ-FOOT", imageEmoji: "👟", accentHex: "#2dd4bf",
    boxContents: ["Pair of shoes", "Spare laces", "Shoe bag"], codEligible: true,
  },
  {
    sku: "VJ-SHOE-102", title: "Kolhapuri Handcrafted Chappal", brand: "Virasat",
    category: "footwear", subcategory: "sandals",
    description: "Genuine leather Kolhapuri chappal, hand-stitched in Maharashtra. Flat sole, traditional braided toe loop.",
    attributes: { sizes: "6-11", colour: "Tan", material: "Buffalo leather", use: "ethnic" },
    tags: ["chappal", "sandal", "kolhapuri", "leather", "ethnic", "slipper", "chappals", "ಚಪ್ಪಲಿ", "செருப்பு", "चप्पल"],
    solves: ["traditional wear", "wedding", "festival", "ethnic outfit", "pooja", "kurta matching", "saree matching", "comfortable flat sandal", "summer wear"],
    priceInr: 899, mrpInr: 1499, ratingAvg: 4.5, ratingCount: 1203, stock: 64,
    sellerId: "SEL-01", policyId: "VJ-FOOT", imageEmoji: "🩴", accentHex: "#c2410c",
    boxContents: ["Pair of chappals", "Care card"], codEligible: true,
  },
  {
    sku: "VJ-SHOE-103", title: "Trail Grip Hiking Boots", brand: "Summit",
    category: "footwear", subcategory: "boots",
    description: "Water-resistant high-ankle hiking boots with a deep lug rubber outsole and padded collar.",
    attributes: { sizes: "7-11", colour: "Brown", waterproof: true, use: "hiking" },
    tags: ["boot", "boots", "hiking", "trekking", "outdoor", "joota", "shoe"],
    solves: ["trekking", "hiking", "monsoon", "rain", "muddy ground", "ankle support", "outdoor trip", "heavy walking", "waterproof shoe", "mountain travel"],
    priceInr: 3299, mrpInr: 5999, ratingAvg: 4.2, ratingCount: 612, stock: 22,
    sellerId: "SEL-01", policyId: "VJ-FOOT", imageEmoji: "🥾", accentHex: "#78350f",
    boxContents: ["Pair of boots", "Spare laces"], codEligible: true,
  },
  {
    sku: "VJ-SHOE-104", title: "Everyday Canvas Sneakers", brand: "Stride",
    category: "footwear", subcategory: "sneakers",
    description: "Classic low-top canvas sneakers with a vulcanised rubber sole. Machine washable.",
    attributes: { sizes: "6-11", colour: "White", material: "Canvas", use: "casual" },
    tags: ["sneaker", "canvas", "casual", "shoe", "shoes", "joota", "sasta", "cheap", "budget"],
    solves: ["college", "everyday wear", "cheap shoe", "first job", "casual outfit", "jeans matching", "machine washable", "budget shoe", "school", "tight budget"],
    priceInr: 799, mrpInr: 1599, ratingAvg: 3.9, ratingCount: 3402, stock: 110,
    sellerId: "SEL-01", policyId: "VJ-FOOT", imageEmoji: "👟", accentHex: "#64748b",
    boxContents: ["Pair of sneakers"], codEligible: true,
  },

  // ── Electronics ─────────────────────────────────────────────────────
  {
    sku: "VJ-ELEC-201", title: "SonicBuds Air Pro Wireless Earbuds", brand: "Sonic",
    category: "electronics", subcategory: "earbuds",
    description: "True wireless earbuds with hybrid active noise cancellation, 32-hour total battery with the case, and USB-C fast charge.",
    attributes: { anc: true, battery_hours: 32, bluetooth: "5.3", ipx: "IPX5", colour: "Midnight" },
    tags: ["earbud", "earbuds", "earphone", "headphone", "tws", "bluetooth", "anc", "kaan", "ಇಯರ್‌ಬಡ್", "ஒலி", "हेडफोन", "इयरफोन"],
    solves: ["listen to music while running", "gym music", "calls while working", "work from home calls", "block out noise", "noisy office", "flight travel", "podcast", "online class", "commute", "music on the go", "hands free calling"],
    priceInr: 2499, mrpInr: 5999, ratingAvg: 4.4, ratingCount: 8921, stock: 75,
    sellerId: "SEL-02", policyId: "VJ-ELEC", imageEmoji: "🎧", accentHex: "#6366f1",
    boxContents: ["Earbuds", "Charging case", "USB-C cable", "3 pairs of ear tips", "Manual"], codEligible: true,
  },
  {
    sku: "VJ-ELEC-202", title: "PowerCore 20000mAh Power Bank", brand: "Voltix",
    category: "electronics", subcategory: "power bank",
    description: "20000mAh power bank with 22.5W fast charging, dual USB-A and one USB-C PD port. Airline cabin safe.",
    attributes: { capacity_mah: 20000, output_w: 22.5, ports: 3, colour: "Black" },
    tags: ["power bank", "powerbank", "charger", "battery", "portable", "charging", "ಚಾರ್ಜರ್", "சார்ஜர்", "चार्जर"],
    solves: ["phone dies quickly", "long travel", "power cut", "load shedding", "charge on the go", "festival travel", "train journey", "backup battery", "camping", "no plug point"],
    priceInr: 1799, mrpInr: 3499, ratingAvg: 4.3, ratingCount: 5120, stock: 90,
    sellerId: "SEL-02", policyId: "VJ-ELEC", imageEmoji: "🔋", accentHex: "#0ea5e9",
    boxContents: ["Power bank", "USB-C cable", "Pouch", "Warranty card"], codEligible: true,
  },
  {
    sku: "VJ-ELEC-203", title: "FitTrack Pulse Smartwatch", brand: "FitTrack",
    category: "electronics", subcategory: "smartwatch",
    description: "1.8-inch AMOLED smartwatch with SpO2, heart rate and sleep tracking, 100+ sport modes and 10-day battery.",
    attributes: { display: "1.8 AMOLED", battery_days: 10, spo2: true, calls: true, colour: "Black" },
    tags: ["watch", "smartwatch", "fitness", "band", "tracker", "ghadi", "ಗಡಿಯಾರ", "கடிகாரம்", "घड़ी"],
    solves: ["track my steps", "fitness tracking", "heart rate", "sleep tracking", "blood oxygen", "gift for fitness", "daily activity", "health monitoring", "notifications on wrist"],
    priceInr: 2199, mrpInr: 6999, ratingAvg: 4.1, ratingCount: 4433, stock: 58,
    sellerId: "SEL-02", policyId: "VJ-ELEC", imageEmoji: "⌚", accentHex: "#8b5cf6",
    boxContents: ["Smartwatch", "Magnetic charger", "Extra strap", "Manual"], codEligible: true,
  },
  {
    sku: "VJ-ELEC-204", title: "BoomBox Mini Bluetooth Speaker", brand: "Sonic",
    category: "electronics", subcategory: "speaker",
    description: "Portable 10W Bluetooth speaker with passive bass radiator, IPX7 waterproofing and 14-hour playback.",
    attributes: { output_w: 10, battery_hours: 14, ipx: "IPX7", colour: "Olive" },
    tags: ["speaker", "bluetooth", "boombox", "music", "audio", "sound", "ಸ್ಪೀಕರ್", "ஒலிபெருக்கி", "स्पीकर"],
    solves: ["music at home", "party", "outdoor music", "bathroom music", "picnic", "loud music", "waterproof speaker", "bluetooth music", "small room music"],
    priceInr: 1499, mrpInr: 2999, ratingAvg: 4.2, ratingCount: 2210, stock: 67,
    sellerId: "SEL-02", policyId: "VJ-ELEC", imageEmoji: "🔊", accentHex: "#10b981",
    boxContents: ["Speaker", "USB-C cable", "Wrist strap"], codEligible: true,
  },
  {
    sku: "VJ-ELEC-205", title: "Vision 43-inch 4K Smart LED TV", brand: "Vision",
    category: "electronics", subcategory: "television",
    description: "43-inch 4K Ultra HD smart LED television with HDR10, 20W box speakers and built-in streaming apps.",
    attributes: { size_inch: 43, resolution: "3840x2160", hdr: "HDR10", audio_w: 20 },
    tags: ["tv", "television", "led", "smart tv", "4k", "ಟಿವಿ", "தொலைக்காட்சி", "टीवी"],
    solves: ["family entertainment", "watch movies", "watch cricket", "cricket match", "living room tv", "netflix", "youtube on big screen", "streaming", "upgrade old tv"],
    priceInr: 21999, mrpInr: 38999, ratingAvg: 4.0, ratingCount: 1876, stock: 14,
    sellerId: "SEL-02", policyId: "VJ-ELEC", imageEmoji: "📺", accentHex: "#1e293b",
    boxContents: ["Television", "Remote", "2 AAA batteries", "Table stand", "Wall mount kit", "Manual"], codEligible: false,
  },

  // ── Apparel ─────────────────────────────────────────────────────────
  {
    sku: "VJ-APP-301", title: "Kanchipuram Silk Saree", brand: "Kanchi",
    category: "apparel", subcategory: "saree",
    description: "Handwoven pure Kanchipuram silk saree with a contrast zari border and matching unstitched blouse piece.",
    attributes: { fabric: "Pure silk", length_m: 6.3, blouse: "0.8m unstitched", colour: "Maroon/Gold" },
    tags: ["saree", "sari", "silk", "kanchipuram", "ethnic", "wedding", "ಸೀರೆ", "புடவை", "साड़ी"],
    solves: ["wedding", "festival", "traditional function", "gift for mother", "gift for wife", "pooja", "reception", "ethnic wear", "silk saree gift", "anniversary"],
    priceInr: 6499, mrpInr: 12999, ratingAvg: 4.7, ratingCount: 892, stock: 19,
    sellerId: "SEL-03", policyId: "VJ-APP", imageEmoji: "🥻", accentHex: "#b91c1c",
    boxContents: ["Saree", "Unstitched blouse piece", "Authenticity card"], codEligible: true,
  },
  {
    sku: "VJ-APP-302", title: "Cotton Straight Kurta", brand: "Rangsutra",
    category: "apparel", subcategory: "kurta",
    description: "Breathable 100% cotton straight-cut kurta with a mandarin collar and side slits. Pre-shrunk.",
    attributes: { fabric: "100% cotton", sizes: "S-XXL", fit: "Straight", colour: "Indigo" },
    tags: ["kurta", "kurti", "cotton", "ethnic", "shirt", "kapda", "ಕುರ್ತಾ", "குர்தா", "कुर्ता", "कपड़ा"],
    solves: ["summer clothing", "casual ethnic wear", "breathable clothing", "hot humid weather", "daily wear", "comfortable kurta", "sweating in summer", "cotton clothing"],
    priceInr: 749, mrpInr: 1499, ratingAvg: 4.2, ratingCount: 3011, stock: 140,
    sellerId: "SEL-03", policyId: "VJ-APP", imageEmoji: "👔", accentHex: "#3730a3",
    boxContents: ["Kurta"], codEligible: true,
  },
  {
    sku: "VJ-APP-303", title: "Slim Fit Stretch Denim Jeans", brand: "Urban Co",
    category: "apparel", subcategory: "jeans",
    description: "Slim-fit stretch denim with a mid rise and five-pocket styling. 2% elastane for all-day comfort.",
    attributes: { fabric: "98% cotton 2% elastane", sizes: "28-40", fit: "Slim", colour: "Dark wash" },
    tags: ["jeans", "denim", "pant", "trouser", "jean", "pants", "कपड़ा", "ಜೀನ್ಸ್"],
    solves: ["office wear", "college", "casual outing", "everyday pant", "stretchable jeans", "comfortable denim", "party wear"],
    priceInr: 1299, mrpInr: 2999, ratingAvg: 4.0, ratingCount: 5621, stock: 95,
    sellerId: "SEL-03", policyId: "VJ-APP", imageEmoji: "👖", accentHex: "#1e3a8a",
    boxContents: ["Jeans"], codEligible: true,
  },

  // ── Home ────────────────────────────────────────────────────────────
  {
    sku: "VJ-HOME-401", title: "400TC Cotton Double Bedsheet Set", brand: "Nivaas",
    category: "home", subcategory: "bedsheet",
    description: "400 thread count cotton double bedsheet with two pillow covers. Fade-resistant reactive dyes.",
    attributes: { thread_count: 400, size: "90x100 inch", pieces: 3, colour: "Sage" },
    tags: ["bedsheet", "bed sheet", "bedding", "chadar", "ಹಾಸಿಗೆ", "விரிப்பு", "चादर", "बेडशीट"],
    solves: ["new home", "bedroom refresh", "double bed", "soft bedsheet", "summer bedding", "gift for new house", "housewarming", "change old bedsheet"],
    priceInr: 1099, mrpInr: 2499, ratingAvg: 4.3, ratingCount: 4120, stock: 88,
    sellerId: "SEL-04", policyId: "VJ-HOME", imageEmoji: "🛏️", accentHex: "#15803d",
    boxContents: ["1 double bedsheet", "2 pillow covers"], codEligible: true,
  },
  {
    sku: "VJ-HOME-402", title: "Memory Foam Pillow, Pack of 2", brand: "Nivaas",
    category: "home", subcategory: "pillow",
    description: "Orthopaedic memory foam pillows with a removable, washable bamboo-blend cover.",
    attributes: { pieces: 2, fill: "Memory foam", size: "24x16 inch", firmness: "Medium" },
    tags: ["pillow", "cushion", "takiya", "ದಿಂಬು", "தலையணை", "तकिया"],
    solves: ["back pain", "neck pain", "cervical pain", "orthopaedic support", "gift for mother", "gift for father", "gift for parents", "elderly comfort", "neck support", "spine support", "sleeping problem", "stiff neck", "old parents", "shoulder pain", "posture"],
    priceInr: 899, mrpInr: 1999, ratingAvg: 4.1, ratingCount: 2310, stock: 72,
    sellerId: "SEL-04", policyId: "VJ-HOME", imageEmoji: "🛌", accentHex: "#059669",
    boxContents: ["2 pillows", "2 covers"], codEligible: true,
  },

  // ── Kitchen ─────────────────────────────────────────────────────────
  {
    sku: "VJ-KITCH-501", title: "Stainless Steel Pressure Cooker, 5L", brand: "Ganga",
    category: "kitchen", subcategory: "pressure cooker",
    description: "5 litre induction-base stainless steel pressure cooker with a precision weight valve and gasket release system. ISI marked.",
    attributes: { capacity_l: 5, material: "Stainless steel", induction: true, isi: true },
    tags: ["cooker", "pressure cooker", "kadai", "kitchen", "cooking", "ಕುಕ್ಕರ್", "குக்கர்", "कुकर", "बर्तन"],
    solves: ["cook rice", "cook dal", "cook for family", "induction cooking", "daily cooking", "quick cooking", "save gas", "family of four", "pressure cooking", "sambar", "biryani", "cook rice quickly"],
    priceInr: 1649, mrpInr: 2999, ratingAvg: 4.4, ratingCount: 6712, stock: 54,
    sellerId: "SEL-05", policyId: "VJ-KITCH", imageEmoji: "🍲", accentHex: "#94a3b8",
    boxContents: ["Cooker body", "Lid", "Gasket", "Safety valve", "Weight", "Manual", "Recipe book"], codEligible: true,
  },
  {
    sku: "VJ-KITCH-502", title: "Mixer Grinder 750W, 3 Jars", brand: "Ganga",
    category: "kitchen", subcategory: "mixer grinder",
    description: "750W mixer grinder with three stainless steel jars, overload protection and a 2-year motor warranty.",
    attributes: { power_w: 750, jars: 3, speeds: 3, warranty_years: 2 },
    tags: ["mixer", "grinder", "mixie", "blender", "juicer", "kitchen", "ಮಿಕ್ಸರ್", "மிக்ஸி", "मिक्सर"],
    solves: ["grind masala", "make chutney", "make batter", "batter for dosa", "idli batter", "juice", "smoothie", "grind coconut", "wet grinding", "kitchen appliance", "gift for new home"],
    priceInr: 2799, mrpInr: 4999, ratingAvg: 4.2, ratingCount: 3890, stock: 41,
    sellerId: "SEL-05", policyId: "VJ-KITCH", imageEmoji: "🧃", accentHex: "#e11d48",
    boxContents: ["Motor unit", "Wet grinding jar", "Dry grinding jar", "Chutney jar", "3 blades", "Manual"], codEligible: true,
  },
  {
    sku: "VJ-KITCH-503", title: "Vacuum Insulated Steel Bottle, 1L", brand: "Ganga",
    category: "kitchen", subcategory: "bottle",
    description: "Double-walled vacuum insulated bottle. Keeps liquids hot for 18 hours and cold for 24. Leak-proof cap.",
    attributes: { capacity_ml: 1000, hot_hours: 18, cold_hours: 24, material: "18/8 steel" },
    tags: ["bottle", "flask", "thermos", "water bottle", "ಬಾಟಲಿ", "பாட்டில்", "बोतल"],
    solves: ["carry water", "hot water", "cold water", "office water bottle", "travel bottle", "gym bottle", "school bottle", "keep tea hot", "leak proof bottle"],
    priceInr: 699, mrpInr: 1299, ratingAvg: 4.5, ratingCount: 7120, stock: 130,
    sellerId: "SEL-05", policyId: "VJ-KITCH", imageEmoji: "🍶", accentHex: "#0f766e",
    boxContents: ["Bottle", "Spare silicone seal"], codEligible: true,
  },

  {
    sku: "VJ-KITCH-504", title: "Aluminium Pressure Cooker, 3L", brand: "Hearth",
    category: "kitchen", subcategory: "pressure cooker",
    description: "Lightweight 3 litre anodised aluminium pressure cooker for gas stoves. Not compatible with induction hobs.",
    attributes: { capacity_l: 3, material: "Anodised aluminium", induction: false, isi: true },
    tags: ["cooker", "pressure cooker", "aluminium", "small", "kitchen", "ಕುಕ್ಕರ್", "குக்கர்", "कुकर"],
    solves: ["cook rice", "small family", "cook for two", "gas stove cooking", "lightweight cooker", "bachelor cooking", "hostel cooking", "cheap cooker", "single person"],
    priceInr: 1149, mrpInr: 1899, ratingAvg: 4.0, ratingCount: 2140, stock: 60,
    sellerId: "SEL-05", policyId: "VJ-KITCH", imageEmoji: "🍲", accentHex: "#a8a29e",
    boxContents: ["Cooker body", "Lid", "Gasket", "Safety valve", "Weight", "Manual"], codEligible: true,
  },
  {
    sku: "VJ-KITCH-505", title: "Induction Pressure Cooker, 7.5L", brand: "Ganga",
    category: "kitchen", subcategory: "pressure cooker",
    description: "Large 7.5 litre induction-compatible stainless steel pressure cooker for joint families. ISI marked.",
    attributes: { capacity_l: 7.5, material: "Stainless steel", induction: true, isi: true },
    tags: ["cooker", "pressure cooker", "large", "family", "kitchen", "ಕುಕ್ಕರ್", "குக்கர்", "कुकर"],
    solves: ["cook for large family", "joint family", "cook rice for many", "bulk cooking", "guests", "function cooking", "induction cooking", "big cooker", "cook rice quickly"],
    priceInr: 2449, mrpInr: 3999, ratingAvg: 4.3, ratingCount: 1870, stock: 28,
    sellerId: "SEL-05", policyId: "VJ-KITCH", imageEmoji: "🍲", accentHex: "#78716c",
    boxContents: ["Cooker body", "Lid", "Gasket", "Safety valve", "Weight", "Manual"], codEligible: true,
  },

  // ── Beauty ──────────────────────────────────────────────────────────
  {
    sku: "VJ-BEAU-601", title: "Kumkumadi Brightening Face Oil", brand: "Vedic",
    category: "beauty", subcategory: "face oil",
    description: "Ayurvedic kumkumadi face oil with saffron and sandalwood in a sesame base. 30ml glass dropper bottle.",
    attributes: { volume_ml: 30, type: "Face oil", ayurvedic: true, vegan: true },
    tags: ["oil", "face oil", "serum", "ayurvedic", "kumkumadi", "skincare", "cream", "ತೈಲ", "எண்ணெய்", "तेल"],
    solves: ["dull skin", "glowing skin", "pigmentation", "dark spots", "ayurvedic skincare", "gift for wife", "face glow", "dry skin", "wedding skin prep", "natural skincare"],
    priceInr: 849, mrpInr: 1450, ratingAvg: 4.4, ratingCount: 1980, stock: 76,
    sellerId: "SEL-06", policyId: "VJ-BEAUTY", imageEmoji: "🧴", accentHex: "#f59e0b",
    boxContents: ["30ml bottle", "Glass dropper", "Leaflet"], codEligible: true,
  },
  {
    sku: "VJ-BEAU-602", title: "Onion & Bhringraj Hair Shampoo, 300ml", brand: "Vedic",
    category: "beauty", subcategory: "shampoo",
    description: "Sulphate-free shampoo with onion seed oil and bhringraj for hair fall control. Suitable for daily use.",
    attributes: { volume_ml: 300, sulphate_free: true, paraben_free: true },
    tags: ["shampoo", "hair", "onion", "bhringraj", "soap", "ಶಾಂಪೂ", "ஷாம்பு", "शैम्पू"],
    solves: ["hair fall", "hair loss", "thinning hair", "dandruff", "scalp care", "sulphate free shampoo", "natural hair care", "hair growth", "weak hair"],
    priceInr: 399, mrpInr: 699, ratingAvg: 4.0, ratingCount: 5430, stock: 165,
    sellerId: "SEL-06", policyId: "VJ-BEAUTY", imageEmoji: "🧪", accentHex: "#7c3aed",
    boxContents: ["300ml bottle"], codEligible: true,
  },

  // -- Added to close the gaps a buyer runs into first -----------------
  // Every title carries the plain noun someone would say out loud, so a
  // search for "laptop" or "headphones" lands rather than falling through
  // to whatever else shares the category.
  {
    sku: "VJ-ELEC-206", title: "WorkMate 14-inch Laptop, 8GB RAM, 512GB SSD", brand: "WorkMate",
    category: "electronics", subcategory: "laptop",
    description: "A 14-inch laptop for study and office work. Intel i5, 8GB RAM, 512GB SSD, and a claimed 8-hour battery. Weighs 1.4kg, so it travels.",
    attributes: { screen_in: 14, ram_gb: 8, storage_gb: 512, processor: "Intel i5", weight_kg: 1.4, os: "Windows 11", warranty_months: 12 },
    tags: ["laptop", "computer", "notebook", "pc", "lappy", "laptap", "कंप्यूटर", "लैपटॉप", "ಲ್ಯಾಪ್‌ಟಾಪ್", "மடிக்கணினி", "ల్ಯಾಪ್‌ಟಾಪ್", "office", "student"],
    solves: ["college assignments", "office work on a computer", "online classes", "work from home", "coding", "programming", "student laptop"],
    priceInr: 38999, mrpInr: 52999, ratingAvg: 4.2, ratingCount: 1143, stock: 14,
    sellerId: "SEL-02", policyId: "VJ-ELEC", imageEmoji: "💻", accentHex: "#60a5fa",
    boxContents: ["Laptop", "65W charger", "Warranty card"], codEligible: false,
  },
  {
    sku: "VJ-ELEC-207", title: "Lumina 5G Mobile Phone, 128GB", brand: "Lumina",
    category: "electronics", subcategory: "mobile phone",
    description: "A 5G mobile phone with a 6.5-inch display, 50MP camera and a 5000mAh battery that lasts a full day of heavy use.",
    attributes: { screen_in: 6.5, storage_gb: 128, ram_gb: 6, camera_mp: 50, battery_mah: 5000, network: "5G", warranty_months: 12 },
    tags: ["phone", "mobile", "smartphone", "cellphone", "mobile phone", "handset", "फोन", "मोबाइल", "ಮೊಬೈಲ್", "ಫೋನ್", "கைபேசி", "மொபைல்", "ఫోన్", "5g"],
    solves: ["calling", "whatsapp", "taking photos", "video calls", "upi payments", "replace a broken phone", "first smartphone", "phone for parents"],
    priceInr: 14499, mrpInr: 19999, ratingAvg: 4.1, ratingCount: 3267, stock: 31,
    sellerId: "SEL-02", policyId: "VJ-ELEC", imageEmoji: "📱", accentHex: "#818cf8",
    boxContents: ["Phone", "Charger", "USB-C cable", "SIM tool", "Warranty card"], codEligible: true,
  },
  {
    sku: "VJ-ELEC-208", title: "SonicBuds Studio Over-Ear Headphones", brand: "Sonic",
    category: "electronics", subcategory: "headphones",
    description: "Over-ear headphones with active noise cancellation and 40-hour battery. Padded band and a 3.5mm cable for when the battery dies.",
    attributes: { type: "over-ear", noise_cancelling: "yes", battery_hours: 40, wireless: "yes", foldable: "yes", warranty_months: 12 },
    tags: ["headphones", "headphone", "headset", "earphones", "anc", "noise cancelling", "हेडफोन", "ಹೆಡ್‌ಫೋನ್", "ஹெட்போன்", "హెడ్‌ఫోన్", "music"],
    solves: ["listen to music", "block out noise", "study without distraction", "podcasts", "noisy surroundings"],
    priceInr: 2799, mrpInr: 4999, ratingAvg: 4.4, ratingCount: 1876, stock: 44,
    sellerId: "SEL-02", policyId: "VJ-ELEC", imageEmoji: "🎧", accentHex: "#f472b6",
    boxContents: ["Headphones", "Carry pouch", "3.5mm cable", "USB-C cable"], codEligible: true,
  },
  {
    sku: "VJ-KITCH-506", title: "Electric Rice Cooker, 1.8L", brand: "Annapurna",
    category: "kitchen", subcategory: "rice cooker",
    description: "A 1.8 litre electric rice cooker with keep-warm, an inner bowl that lifts out, and a steamer tray for vegetables.",
    attributes: { capacity_l: 1.8, watts: 700, keep_warm: "yes", steamer_tray: "yes", material: "Aluminium", warranty_months: 12 },
    tags: ["rice cooker", "cooker", "electric cooker", "rice", "chawal", "तावल", "कुकर", "ಅಕ್ಕಿ", "ಕುಕ್ಕರ್", "அரிசி", "குக்கர்", "బియ్యం"],
    solves: ["cook rice", "cooking rice daily", "steam vegetables", "idli", "cooking rice for one"],
    priceInr: 1649, mrpInr: 2499, ratingAvg: 4.0, ratingCount: 912, stock: 38,
    sellerId: "SEL-03", policyId: "VJ-KITCH", imageEmoji: "🍚", accentHex: "#fbbf24",
    boxContents: ["Rice cooker", "Inner bowl", "Steamer tray", "Measuring cup", "Spatula"], codEligible: true,
  },
  {
    sku: "VJ-KITCH-507", title: "Electric Kettle, 1.5L Stainless Steel", brand: "Annapurna",
    category: "kitchen", subcategory: "kettle",
    description: "A 1.5 litre stainless steel electric kettle that boils in four minutes and switches itself off when it does.",
    attributes: { capacity_l: 1.5, watts: 1500, material: "Stainless Steel", auto_cutoff: "yes", boil_dry_protection: "yes", warranty_months: 12 },
    tags: ["kettle", "electric kettle", "water heater", "tea", "chai", "केतली", "चाय", "ಕೆಟಲ್", "ಚಹಾ", "கெட்டில்", "టీ"],
    solves: ["boil water", "make tea", "make coffee", "instant noodles", "quick hot water", "maggi"],
    priceInr: 899, mrpInr: 1599, ratingAvg: 4.2, ratingCount: 2104, stock: 62,
    sellerId: "SEL-03", policyId: "VJ-KITCH", imageEmoji: "🫖", accentHex: "#34d399",
    boxContents: ["Kettle", "Power base", "Manual"], codEligible: true,
  },
  {
    sku: "VJ-APP-304", title: "Winter Jacket, Padded and Water-Resistant", brand: "Himalaya",
    category: "apparel", subcategory: "jacket",
    description: "A padded winter jacket with a water-resistant shell, high collar and zip pockets. Warm enough for a north Indian winter or a hill station.",
    attributes: { sizes: "S-XXL", colour: "Charcoal", lining: "Polyester fill", water_resistant: "yes", hooded: "yes", machine_washable: "yes" },
    tags: ["jacket", "winter jacket", "coat", "warm clothes", "sweater", "जैकेट", "कोट", "ಜಾಕೆಟ್", "ஜாக்கெட்", "జాకెట్", "thand", "sardi"],
    solves: ["cold weather", "winter clothing", "hill station trip", "manali trip", "riding a bike in the cold", "snow"],
    priceInr: 1899, mrpInr: 3499, ratingAvg: 4.3, ratingCount: 743, stock: 29,
    sellerId: "SEL-04", policyId: "VJ-APP", imageEmoji: "🧥", accentHex: "#64748b",
    boxContents: ["Jacket"], codEligible: true,
  },
  {
    sku: "VJ-HOME-403", title: "Laptop Backpack, 25L Water-Resistant", brand: "Trek",
    category: "home", subcategory: "backpack",
    description: "A 25 litre backpack with a padded 15-inch laptop sleeve, a water-resistant shell and padded straps. Built for a daily commute.",
    attributes: { capacity_l: 25, laptop_fit_in: 15.6, water_resistant: "yes", compartments: 4, usb_port: "no", warranty_months: 6 },
    tags: ["backpack", "bag", "laptop bag", "school bag", "college bag", "rucksack", "बैग", "बैकपैक", "ಬ್ಯಾಗ್", "பேக்", "బ్యాగ్"],
    solves: ["carry a laptop", "carry books", "college bag", "school bag", "commute with a laptop", "student bag"],
    priceInr: 1199, mrpInr: 2199, ratingAvg: 4.4, ratingCount: 1588, stock: 51,
    sellerId: "SEL-04", policyId: "VJ-HOME", imageEmoji: "🎒", accentHex: "#a78bfa",
    boxContents: ["Backpack", "Rain cover"], codEligible: true,
  },
  {
    sku: "VJ-HOME-404", title: "Dry Iron, 1000W Non-Stick Soleplate", brand: "Crisp",
    category: "home", subcategory: "iron",
    description: "A 1000 watt dry iron with a non-stick soleplate and adjustable thermostat. Light enough to use standing at a table.",
    attributes: { watts: 1000, soleplate: "Non-stick", thermostat: "Adjustable", steam: "no", weight_kg: 0.9, warranty_months: 24 },
    tags: ["iron", "press", "dry iron", "ironing", "istri", "इस्त्री", "आयरन", "ಐರನ್", "இஸ்திரி", "ఐరన్"],
    solves: ["iron clothes", "ironing shirts", "remove creases", "press a uniform", "saree pleats"],
    priceInr: 649, mrpInr: 1099, ratingAvg: 4.1, ratingCount: 3422, stock: 73,
    sellerId: "SEL-05", policyId: "VJ-HOME", imageEmoji: "🔥", accentHex: "#fb7185",
    boxContents: ["Iron", "Manual", "Warranty card"], codEligible: true,
  },
  {
    sku: "VJ-HOME-405", title: "Cotton Bath Towel Set, Pack of 2", brand: "Softloom",
    category: "home", subcategory: "towel",
    description: "Two 500 GSM cotton bath towels, 75 by 150 centimetres. Absorbent from the first wash and they survive a washing machine.",
    attributes: { gsm: 500, size_cm: "75x150", material: "100% Cotton", pack_of: 2, machine_washable: "yes", colour: "Teal/Grey" },
    tags: ["towel", "bath towel", "towels", "tuvale", "तौलिया", "ಟವೆಲ್", "துண்டு", "టవల్", "bathroom"],
    solves: ["drying after a bath", "new home essentials", "guest room", "replace old towels"],
    priceInr: 749, mrpInr: 1399, ratingAvg: 4.3, ratingCount: 1967, stock: 85,
    sellerId: "SEL-05", policyId: "VJ-HOME", imageEmoji: "🧻", accentHex: "#22d3ee",
    boxContents: ["2 bath towels"], codEligible: true,
  },
  {
    sku: "VJ-APP-305", title: "Cotton Socks, Pack of 5 Pairs", brand: "Stride",
    category: "apparel", subcategory: "socks",
    description: "Five pairs of combed cotton ankle socks with a ribbed cuff that does not slide down. Free size, fits 6 to 10.",
    attributes: { pack_of: 5, material: "Combed Cotton", length: "Ankle", sizes: "6-10", colour: "Assorted", machine_washable: "yes" },
    tags: ["socks", "sock", "जुराब", "मोजे", "ಸಾಕ್ಸ್", "காலுறை", "సాక్స్", "cotton socks"],
    solves: ["wear with shoes", "school uniform socks", "sports socks", "cold feet"],
    priceInr: 349, mrpInr: 699, ratingAvg: 4.2, ratingCount: 4211, stock: 120,
    sellerId: "SEL-04", policyId: "VJ-APP", imageEmoji: "🧦", accentHex: "#4ade80",
    boxContents: ["5 pairs of socks"], codEligible: true,
  },
];

/**
 * Demo accounts. Every password is `demo123` — stated on the sign-in screen,
 * because a reviewer should not have to guess or read the seed script.
 */
export const USERS = [
  {
    email: "lakshmi@example.in", name: "Lakshmi Prasad", role: "buyer" as const,
    phone: "+91 90000 10001", lang: "kn", priority: "speed" as const,
    priorRto: 1, totalClaims: 0, rejectedClaims: 0,
    addresses: [{
      label: "Home", line: "Near the water tank, Hosahalli", landmark: "",
      city: "Tumakuru", state: "Karnataka", pincode: "572138", pinTier: 3,
    }],
  },
  {
    email: "arjun@example.in", name: "Arjun Menon", role: "buyer" as const,
    phone: "+91 90000 10002", lang: "en", priority: "speed" as const,
    priorRto: 0, totalClaims: 0, rejectedClaims: 0,
    addresses: [{
      label: "Home", line: "Flat 402, Brigade Residency, 7th Main, Koramangala",
      landmark: "Opposite Forum Mall", city: "Bengaluru", state: "Karnataka",
      pincode: "560034", pinTier: 1,
    }],
  },
  {
    email: "priya@example.in", name: "Priya Sharma", role: "buyer" as const,
    phone: "+91 90000 10003", lang: "hi", priority: "money" as const,
    priorRto: 0, totalClaims: 0, rejectedClaims: 0,
    addresses: [{
      label: "Home", line: "B-14, Shanti Vihar, Sector 12, Dwarka",
      landmark: "Behind the metro pillar 318", city: "New Delhi", state: "Delhi",
      pincode: "110078", pinTier: 1,
    }],
  },
  {
    email: "murugan@example.in", name: "Murugan Subramaniam", role: "buyer" as const,
    phone: "+91 90000 10004", lang: "ta", priority: "money" as const,
    priorRto: 2, totalClaims: 3, rejectedClaims: 2,
    addresses: [{
      label: "Home", line: "12/4 Bazaar Street", landmark: "",
      city: "Karur", state: "Tamil Nadu", pincode: "639001", pinTier: 3,
    }],
  },
  {
    email: "ops@vaanijya.in", name: "Resolution Desk", role: "operator" as const,
    phone: "+91 80000 00001", lang: "en", priority: "money" as const,
    priorRto: 0, totalClaims: 0, rejectedClaims: 0, addresses: [],
  },
];

export const DEMO_PASSWORD = "demo123";
