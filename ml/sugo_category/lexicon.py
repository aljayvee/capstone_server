"""
Seed domain knowledge: what Philippine shop and product names mean.

The classifier in `model.py` learns from real labelled rows — `verified_places`
and the categories dispatchers actually chose on past pins. On a fresh install
there are none of those, and even on a mature install the long tail of Tacurong
shop names is never fully covered. This module is the floor under that: hand
written knowledge of the brands, Tagalog/Bisaya shop words and product names
that a Mindanao dispatcher deals with daily, which Google's `types` array either
mislabels or does not know at all.

It is training data, not a lookup table. Every phrase here becomes a synthetic
training row, so a shop named "Aling Nena Carinderia and Eatery" is scored by a
model that has learned what "carinderia" and "eatery" mean, rather than needing
its exact name to have been seen before. Real rows from the database outweigh
these when the two disagree — see SYNTHETIC_ROW_WEIGHT in model.py.

Category names must match `merchant_categories.name` exactly. They are the only
stable identifier shared with the server; ids are per-environment.
"""

import re

FOOD = "Fast Food & Restaurant"
PHARMACY = "Pharmacy & Health"
GROCERY = "Supermarket & Grocery"
RETAIL = "Retail & General Merchandise"

CATEGORIES = [FOOD, PHARMACY, GROCERY, RETAIL]

# ── store names ────────────────────────────────────────────────────────────
#
# National chains first, then the generic words that name a shop's KIND. The
# generic words matter more than the brands: a brand is one shop, "carinderia"
# is a hundred of them, and character n-grams let the model fire on the word
# wherever it sits inside a longer name.

STORE_PHRASES: dict[str, list[str]] = {
    FOOD: [
        # national chains
        "jollibee", "chowking", "greenwich", "mang inasal", "mcdonalds", "mcdo",
        "kfc", "shakeys", "pizza hut", "dunkin donuts", "bonchon", "army navy",
        "maxs restaurant", "gerrys grill", "andoks", "baliwag lechon manok",
        "reyes barbecue", "goldilocks", "red ribbon", "julies bakeshop",
        "pan de manila", "starbucks", "bos coffee", "yellow cab pizza",
        "angels pizza", "tokyo tokyo", "teriyaki boy", "samgyupsalamat",
        "zarks burgers", "potato corner", "turks shawarma", "papa johns",
        "burger king", "wendys", "subway", "krispy kreme", "cinnabon",
        "macao imperial tea", "serenitea", "chatime", "gong cha", "infinitea",
        "coffee project", "figaro coffee", "seattles best coffee",
        # the kind of place, which is what actually generalises
        "carinderia", "karinderya", "eatery", "kainan", "lutong bahay",
        "restaurant", "resto", "fast food", "food house", "food hub",
        "food court", "canteen", "cafeteria", "cafe", "coffee shop",
        "coffee house", "milk tea shop", "bubble tea", "juice bar",
        "bakery", "bakeshop", "panaderia", "pastry shop", "cake shop",
        "grill", "grill house", "barbecue", "bbq", "ihaw ihaw", "inasal",
        "lechon manok", "lechon baboy", "pares", "lugawan", "silogan",
        "burger stand", "shawarma stand", "pizzeria", "noodle house",
        "seafood restaurant", "chinese restaurant", "japanese restaurant",
        "korean bbq", "buffet", "catering services", "snack house",
        "halo halo house", "ice cream shop", "gelato",
    ],
    PHARMACY: [
        "mercury drug", "watsons", "rose pharmacy", "generika drugstore",
        "the generics pharmacy", "tgp pharmacy", "south star drug",
        "st joseph drug", "healthway", "getwell drug", "farmacia",
        "botika", "botica", "botika ng barangay", "botika ng bayan",
        "pharmacy", "parmasya", "drugstore", "drug store", "drug center",
        "medical clinic", "clinic", "health center", "hospital",
        "dental clinic", "dental care", "optical clinic", "optical shop",
        "eye center", "diagnostic center", "medical laboratory",
        "laboratory services", "xray clinic", "animal clinic", "veterinary clinic",
        "medical supplies", "surgical supplies", "hearing center",
        "wellness center", "therapy center", "dialysis center",
        "herbal store", "vitamins store", "nutrition shop",
    ],
    GROCERY: [
        "puregold", "savemore", "sm supermarket", "sm hypermarket",
        "robinsons supermarket", "robinsons easymart", "gaisano", "gaisano mall",
        "nccc supermarket", "prince hypermart", "prince warehouse club",
        "kcc mall", "shopwise", "waltermart", "landers superstore", "s&r",
        "7 eleven", "seven eleven", "alfamart", "ministop", "lawson",
        "uncle johns", "family mart",
        "sari sari store", "sari-sari", "tindahan", "tindahan ni aling",
        "grocery", "groceria", "grocery store", "supermarket", "hypermarket",
        "mini mart", "minimart", "convenience store", "market",
        "public market", "palengke", "wet market", "talipapa",
        "bigasan", "rice dealer", "rice retailer", "meat shop", "meat store",
        "fish vendor", "isdaan", "fruit stand", "fruit stall",
        "vegetable stand", "gulayan", "poultry supply", "egg dealer",
        "water refilling station", "purified water station",
        "frozen goods", "frozen food store", "delicatessen", "deli",
        "wholesale grocery", "general grocery",
    ],
    RETAIL: [
        "sm department store", "robinsons department store", "unitop",
        "novo jeans", "uniqlo", "penshoppe", "bench", "ace hardware",
        "wilcon depot", "citi hardware", "mr diy", "japan home centre",
        "saizen", "daiso", "national book store", "cd r king",
        "octagon computer", "silicon valley", "abenson", "ansons",
        "automatic centre", "mandaue foam", "home along", "handyman",
        "true value", "toby's sports", "sports central",
        "hardware", "hardware store", "construction supply",
        "builders supply", "electrical supply", "plumbing supply",
        "glass and aluminum", "paint center", "lumber", "sawmill",
        "bookstore", "book shop", "school supplies", "office supplies",
        "stationery store", "printing services", "photocopy center",
        "computer shop", "internet cafe", "cellphone shop", "gadget store",
        "mobile accessories", "appliance center", "appliance store",
        "furniture store", "home depot", "department store",
        "general merchandise", "general merchandising", "merchandise",
        "rtw store", "ready to wear", "boutique", "clothing store",
        "ukay ukay", "thrift shop", "shoe store", "bag shop",
        "beauty supply", "cosmetics store", "salon supply",
        "toy store", "gift shop", "novelty shop", "party needs",
        "agrivet supply", "feeds supply", "farm supply", "garden supply",
        "pet shop", "pet supply", "motor parts", "motorcycle parts",
        "auto supply", "spare parts", "tire supply", "vulcanizing shop",
        "battery shop", "hardware and general merchandise",
        "junk shop", "scrap buyer", "water station supply",
        "tailoring shop", "sewing supply", "fabric store",
    ],
}

# ── item names ─────────────────────────────────────────────────────────────
#
# Which KIND of shop sells this thing. Used by the /categorize-item endpoint so
# stage 3 can guess where a newly added item is bought, and written in the
# vocabulary customers actually type — brand names, Tagalog, and the English
# word side by side, because all three turn up in the same order.

# ── fresh produce ──────────────────────────────────────────────────────────
#
# Both languages, because a customer types whichever comes to mind and the
# dispatcher retypes it however they read it. Absent entirely until
# 2026-09-23, which is why "dragon fruit" came back unclassified in
# production: the list held "banana" and "saging" and almost nothing else
# green.
#
# Aromatics (garlic, onion, ginger) sit here rather than with the cooking
# staples because they are bought at the same counter as the rest of the
# produce. Named rather than inlined so CONTESTED_CONCEPTS can reference the
# same list: an owner who creates a produce category later should move all of
# it, not whichever half someone remembered to copy.
PRODUCE_TERMS: list[str] = [
    "garlic", "bawang", "onion", "sibuyas", "red onion", "ginger", "luya",
    "tomato", "kamatis", "potato", "patatas", "carrot", "karot",
    "cabbage", "repolyo", "lettuce", "letsugas", "cucumber", "pipino",
    "eggplant", "talong", "okra", "string beans", "sitaw", "baguio beans",
    "bitter gourd", "ampalaya", "squash", "kalabasa", "chayote", "sayote",
    "bottle gourd", "upo", "patola", "kangkong", "pechay", "petsay",
    "mustasa", "malunggay", "moringa", "sweet potato", "kamote",
    "taro", "gabi", "singkamas", "radish", "labanos", "bean sprouts",
    "togue", "bell pepper", "chili", "sili", "siling labuyo",
    "lemongrass", "tanglad", "pandan", "spring onion", "leeks",
    "mung beans", "monggo", "corn", "mais", "sweet corn",
    "banana", "saging", "mango", "mangga", "papaya", "pineapple", "pinya",
    "watermelon", "pakwan", "melon", "cantaloupe", "guava", "bayabas",
    "santol", "lanzones", "rambutan", "durian", "marang", "pomelo", "suha",
    "dalandan", "calamansi", "kalamansi", "dayap", "grapes", "ubas",
    "apple", "mansanas", "orange", "pear", "avocado", "atis", "chico",
    "star apple", "kaimito", "jackfruit", "langka", "coconut", "buko",
    "niyog", "soursop", "guyabano", "duhat", "sineguelas", "tamarind",
    "sampalok", "kamias", "dragon fruit", "strawberry", "lemon", "lime",
    "fresh fruits", "fresh vegetables", "gulay", "prutas", "produce",
]

ITEM_PHRASES: dict[str, list[str]] = {
    FOOD: [
        "chickenjoy", "burger steak", "jolly spaghetti", "palabok", "yumburger",
        "chicken joy bucket", "6pc chicken", "burger", "cheeseburger", "fries",
        "french fries", "pizza", "pepperoni pizza", "fried chicken", "chicken wings",
        "siomai", "siopao", "lumpia", "pancit canton bilao", "pancit malabon",
        "sisig", "adobo", "sinigang", "kare kare", "lechon kawali", "crispy pata",
        "rice meal", "silog", "tapsilog", "longsilog", "tosilog", "hotsilog",
        "halo halo", "mais con yelo", "sundae", "ice cream cone", "milkshake",
        "iced coffee", "hot coffee", "latte", "americano", "frappe",
        "milk tea", "wintermelon milk tea", "okinawa milk tea", "fruit tea",
        "cake", "birthday cake", "slice cake", "cupcake", "donut", "ensaymada",
        "pandesal", "spanish bread", "hopia", "empanada", "shawarma",
        "burger patty meal", "family bucket", "solo meal", "value meal",
        "barbecue stick", "isaw", "lechon manok whole", "roasted chicken",
    ],
    PHARMACY: [
        "biogesic", "paracetamol", "neozep", "bioflu", "alaxan", "medicol",
        "mefenamic acid", "dolfenal", "advil", "ibuprofen", "aspirin",
        "amoxicillin", "cefalexin", "azithromycin", "co amoxiclav",
        "cetirizine", "loratadine", "benadryl", "claritin",
        "loperamide", "imodium", "diatabs", "kremil s", "gaviscon", "omeprazole",
        "tempra", "tuseran", "solmux", "ambroxol", "carbocisteine",
        "salbutamol", "ventolin", "nebule", "inhaler",
        "betadine", "povidone iodine", "rubbing alcohol", "isopropyl alcohol",
        "hydrogen peroxide", "band aid", "bandage", "gauze pad", "cotton balls",
        "micropore tape", "thermometer", "face mask", "surgical mask",
        "alcohol swab", "syringe", "insulin", "glucose strips", "bp monitor",
        "vitamins", "ascorbic acid", "vitamin c", "centrum", "enervon",
        "myra e", "ferrous sulfate", "calcium tablet", "folic acid",
        "metformin", "losartan", "amlodipine", "atorvastatin", "simvastatin",
        "maintenance medicine", "prescription medicine", "antibiotic",
        "ointment", "antiseptic", "muscle pain relief", "liniment", "efficascent",
        "salonpas", "katinko", "white flower", "alcohol gel", "hand sanitizer",
    ],
    GROCERY: [
        "rice", "bigas", "sinandomeng", "jasmine rice", "sugar", "asukal",
        "brown sugar", "salt", "asin", "cooking oil", "mantika", "canola oil",
        "soy sauce", "toyo", "vinegar", "suka", "fish sauce", "patis",
        "ketchup", "banana ketchup", "mayonnaise", "oyster sauce",
        "milk", "gatas", "evaporated milk", "condensed milk", "powdered milk",
        "bear brand", "alaska milk", "nido", "coffee", "kape", "kopiko",
        "nescafe", "great taste", "milo", "ovaltine", "3 in 1 coffee",
        "bread", "tasty bread", "loaf bread", "eggs", "itlog", "tray of eggs",
        "chicken", "manok", "whole chicken", "pork", "baboy", "liempo",
        "beef", "baka", "ground beef", "fish", "isda", "bangus", "tilapia",
        "galunggong", "tuna", "hotdog", "tender juicy", "tocino", "longganisa",
        "corned beef", "argentina", "sardines", "sardinas", "ligo", "555",
        "century tuna", "spam", "luncheon meat", "instant noodles",
        "lucky me", "pancit canton", "cup noodles", "payless",
        "detergent", "tide", "surf", "ariel", "champion", "downy", "fabric conditioner",
        "zonrox", "bleach", "joy dishwashing", "dishwashing liquid",
        "shampoo", "sunsilk", "creamsilk", "head and shoulders", "conditioner",
        "safeguard", "soap", "sabon", "bath soap", "toothpaste", "colgate",
        "close up", "toothbrush", "tissue", "bathroom tissue", "wet wipes",
        "diaper", "pampers", "eq diaper", "huggies", "sanitary napkin", "modess",
        "whisper", "softdrinks", "coke", "sprite", "royal", "pepsi", "mountain dew",
        "mineral water", "distilled water", "ice", "juice", "zesto", "tang",
        "snacks", "chips", "piattos", "nova", "chippy", "boy bawang",
        "biscuit", "skyflakes", "rebisco", "fita", "cream o", "oreo",
        "candy", "chocolate", "chocnut", "mentos", "maxx", "instant coffee sachet",
        "flour", "harina", "baking powder", "yeast", "pasta", "spaghetti noodles",
        "tomato sauce", "del monte", "seasoning", "magic sarap", "knorr cubes",
        *PRODUCE_TERMS,
    ],
    RETAIL: [
        "notebook", "spiral notebook", "yellow pad", "ballpen", "pentel pen",
        "pencil", "eraser", "sharpener", "ruler", "bond paper", "a4 paper",
        "short bond paper", "folder", "envelope", "glue", "elmers glue",
        "scissors", "stapler", "staple wire", "tape", "masking tape",
        "school supplies", "art materials", "crayons", "watercolor",
        "charger", "phone charger", "usb cable", "type c cable", "powerbank",
        "earphones", "headset", "bluetooth speaker", "memory card", "flash drive",
        "battery", "aa battery", "light bulb", "bombilya", "led bulb",
        "extension cord", "electrical wire", "outlet", "switch",
        "nails", "pako", "hammer", "martilyo", "screwdriver", "pliers",
        "wrench", "sandpaper", "paint", "pintura", "paint brush", "cement",
        "semento", "plywood", "lumber", "gi sheet", "pvc pipe", "faucet",
        "gripo", "hose", "water hose", "padlock", "door knob", "hinge",
        "broom", "walis tambo", "walis tingting", "dustpan", "mop", "basahan",
        "pail", "timba", "basin", "palanggana", "plastic container", "tupperware",
        "plate", "plato", "baso", "glass", "kutsara", "tinidor", "kaldero",
        "kawali", "frying pan", "rice cooker", "electric fan", "flat iron",
        "towel", "bath towel", "bedsheet", "kumot", "pillow", "unan",
        "curtain", "kurtina", "hanger", "clothespin", "sipit",
        "slippers", "tsinelas", "shoes", "sapatos", "sandals", "rubber shoes",
        "shirt", "t shirt", "polo shirt", "pants", "maong", "shorts", "socks",
        "underwear", "bra", "panty", "brief", "uniform", "school uniform",
        "bag", "backpack", "umbrella", "payong", "wallet", "belt", "cap",
        "toy", "laruan", "doll", "toy car", "board game", "puzzle",
        "gift wrapper", "ribbon", "balloon", "party hat", "candle", "kandila",
        "dog food", "cat food", "pet shampoo", "fertilizer", "abono",
        "insecticide", "baygon", "mosquito coil", "katol", "rat poison",
        "motor oil", "brake pad", "spark plug", "motorcycle helmet",
    ],
}


# ── concepts an owner may promote into a category of their own ─────────────
#
# `merchant_categories` is owner-editable, and production carries a "Bakery"
# that this file files under Fast Food & Restaurant. Left alone, the seed
# phrases below would actively argue AGAINST the real Bakery rows a dispatcher
# has already labelled — the lexicon asserting a taxonomy the business has since
# moved past.
#
# When the live catalogue defines a category whose name matches a key here, the
# listed phrases are re-labelled to it instead of their default parent. Keyed by
# the category name an owner would plausibly type.
CONTESTED_CONCEPTS: dict[str, list[str]] = {
    # A Filipino panaderia's shelf, not just its sign. The first version had
    # twenty phrases, so "pan de coco", "kababayan" and "monay" were read
    # letter by letter as food, and "Spanish bread" went to Jollibee.
    "Bakery": [
        # the shop
        "bakery", "bakeshop", "bakeshoppe", "bake shop", "bakehouse", "bake house",
        "panaderia", "panaderya", "pastry shop", "pastries", "patisserie", "cake shop",
        "cakes and pastries", "bread house", "julies bakeshop", "pan de manila",
        "goldilocks", "red ribbon", "french baker", "breadtalk",
        # breads
        "bread", "pandesal", "pan de sal", "pan desal", "malunggay pandesal",
        "ube pandesal", "cheese pandesal", "whole wheat pandesal", "spanish bread",
        "ensaymada", "ensaimada", "cheese ensaymada", "hopia", "hopia mongo",
        "hopia ube", "hopia baboy", "monay", "putok", "star bread", "pan de coco",
        "kababayan", "pan de leche", "pan de regla", "kalihim", "pinagong",
        "cheese bread", "tuna bread", "garlic bread", "raisin bread", "cheese roll",
        "cinnamon roll", "bread roll", "dinner roll", "tasty", "tasty bread",
        "loaf bread", "sliced bread", "whole wheat bread", "banana bread",
        "croissant", "bagel", "baguette",
        # cakes and sweets
        "cake", "birthday cake", "slice cake", "cupcake", "chiffon cake", "mocha cake",
        "ube cake", "chocolate cake", "roll cake", "custard cake", "banana cake",
        "brazo de mercedes", "mamon", "mamon tostado", "pianono", "egg pie",
        "buko pie", "crinkles", "cookies", "brownies", "muffin", "donut", "doughnut",
        "biscocho", "otap", "broas", "silvanas", "sans rival",
    ],
    # Production added "Convenience Store" on 2026-09-24 and filed a 7-Eleven
    # under it. Without this entry the chains below kept arguing for Supermarket
    # & Grocery, and the category got only generate_dynamic_seeds' guesses
    # ("convenience store shop"). OpenStreetMap agrees with the split: the
    # Philippines extract tags 21,912 named shops `shop=convenience`, the chains
    # (7-Eleven alone is 3,065 of them) and thousands of sari-sari stores.
    "Convenience Store": [
        "7 eleven", "seven eleven", "alfamart", "ministop", "lawson",
        "uncle johns", "family mart", "sari sari store", "sari-sari",
        "tindahan", "tindahan ni aling", "mini mart", "minimart",
        "convenience store",
    ],
    "Beverages": [
        "milk tea shop", "bubble tea", "juice bar", "coffee shop",
        "coffee house", "milk tea", "wintermelon milk tea",
        "okinawa milk tea", "fruit tea", "iced coffee", "hot coffee",
        # Prepared cafe drinks follow the beverage role when the owner splits
        # it from fast food. Previously latte/americano/frappe remained fast
        # food seeds even with Cafe active. Keep packaged/instant coffee in
        # Grocery: a cafe vocabulary must not absorb the whole coffee aisle.
        "cafe", "caffe", "coffeehouse", "espresso bar",
        "latte", "americano", "frappe", "cappuccino", "espresso",
        "macchiato", "mocha", "flat white", "cafe au lait",
        "cold brew", "brewed coffee", "filter coffee", "pour over coffee",
        "iced latte", "hot latte", "iced americano", "caramel macchiato",
        "matcha latte", "chai latte", "espresso shot",
    ],
    # Produce currently files under Supermarket & Grocery, which is right for a
    # catalogue with no separate produce row. An owner who splits the palengke
    # out later gets the whole vocabulary moved rather than the half someone
    # remembered to re-enter. Three spellings because the name is the match key
    # and there is no telling which one they will type.
    "Fruits & Vegetables": [
        *PRODUCE_TERMS, "fruit stand", "fruit stall", "vegetable stand", "gulayan",
    ],
    "Fresh Produce": [
        *PRODUCE_TERMS, "fruit stand", "fruit stall", "vegetable stand", "gulayan",
    ],
    "Palengke": [
        *PRODUCE_TERMS, "fruit stand", "fruit stall", "vegetable stand", "gulayan",
        "public market", "wet market", "talipapa",
    ],
}


def generate_dynamic_seeds(category_name: str) -> list[tuple[str, str, str]]:
    """
    Generate synthetic seed rows for an owner-created category so the model
    can immediately classify matching stores and items before real orders accumulate.
    """
    clean = category_name.strip()
    lower = clean.lower()
    seeds: list[tuple[str, str, str]] = [
        # Store patterns
        (lower, clean, "store"),
        (f"{lower} shop", clean, "store"),
        (f"{lower} store", clean, "store"),
        (f"{lower} center", clean, "store"),
        (f"{lower} hub", clean, "store"),
        (f"tindahan ng {lower}", clean, "store"),
        # Item patterns
        (lower, clean, "item"),
        (f"{lower} supplies", clean, "item"),
        (f"{lower} item", clean, "item"),
    ]
    # Split composite names (e.g., "Pet Supplies & Accessories") into word stems
    sub_words = [w.strip() for w in re.split(r"[&,/\-\s]+", lower) if len(w.strip()) > 2]
    for word in sub_words:
        seeds.append((f"{word} shop", clean, "store"))
        seeds.append((f"{word} store", clean, "store"))
        seeds.append((word, clean, "item"))
    return seeds


# Words too broad to move lexicon phrases by containment: "Pet Food" must not
# take "fast food" and "food court" with it. A description phrase that IS one of
# these still seeds its category; it just moves nothing.
_GENERIC_WORDS = {
    "food", "foods", "supplies", "supply", "store", "stores", "shop", "shops", "goods", "products",
    "items", "services", "service", "general", "center", "house", "things", "stuff", "accessories",
}


def _mentions_phrase(text: str, key: str) -> bool:
    from .catalogue import singular

    return f" {key} " in f" {singular(text)} "


def synthetic_rows(allowed=None) -> list[tuple[str, str, str]]:
    """
    Every seed phrase as a `(text, category, kind)` training row.

    `kind` is "store" or "item" — the two models are trained separately because
    the same word means different things on each side: "Mercury Drug" is a shop,
    "Biogesic" is something bought in one, and a model that saw both in one pile
    would learn neither cleanly.

    `allowed` is the live catalogue: a catalogue.Catalogue (names and
    descriptions), a set of names, or None for the lexicon's own four. Each
    phrase goes to the live category carrying its role (catalogue.py), so a
    renamed category keeps its vocabulary, and a phrase whose role no category
    carries is left out rather than taught under a name the API cannot use.
    Where a category carries a concept in CONTESTED_CONCEPTS (Bakery), those
    phrases move to it from their default parent. The owner's own categories
    get dynamic seeds from their name, and their description's phrases both
    seed them and pull matching lexicon phrases over ("nails, cement" moves
    the lexicon's nails and cement from Retail to "Hardware & Construction").
    """
    from .catalogue import Catalogue, description_phrases, role_for_label, singular

    catalogue = Catalogue.of(allowed)
    moved: dict[str, str] = {}
    for concept, phrases in CONTESTED_CONCEPTS.items():
        role = role_for_label(concept)
        target = catalogue.category_for_role(role.key, fall_back=False) if role else (concept if concept in catalogue else None)
        if target:
            for phrase in phrases:
                moved[phrase] = target

    rows: list[tuple[str, str, str]] = []
    for category, phrases in STORE_PHRASES.items():
        home = catalogue.resolve(category)
        rows.extend((phrase, moved.get(phrase, home), "store") for phrase in phrases if moved.get(phrase, home))
    for category, phrases in ITEM_PHRASES.items():
        home = catalogue.resolve(category)
        rows.extend((phrase, moved.get(phrase, home), "item") for phrase in phrases if moved.get(phrase, home))

    # A promoted concept may list phrases that appear in neither STORE_PHRASES
    # nor ITEM_PHRASES. Add them so the new category gets real seed coverage
    # rather than only whatever the live rows happen to carry.
    if moved:
        seen = {(text, kind) for text, _, kind in rows}
        for phrase, concept in moved.items():
            for kind in ("store", "item"):
                if (phrase, kind) not in seen:
                    rows.append((phrase, concept, kind))

    # The owner's own categories: seeds from the name, then the description.
    for custom in catalogue.custom():
        rows.extend(generate_dynamic_seeds(custom))
        phrases = description_phrases(catalogue.descriptions.get(custom))
        keys = [singular(p) for p in phrases]
        movable = [k for k in keys if len(k) >= 4 and not set(k.split()) <= _GENERIC_WORDS]
        if movable:
            rows = [
                (text, custom if any(_mentions_phrase(text, k) for k in movable) else cat, kind)
                for text, cat, kind in rows
            ]
        for phrase in phrases:
            rows.append((phrase, custom, "store"))
            rows.append((phrase, custom, "item"))

    return rows

