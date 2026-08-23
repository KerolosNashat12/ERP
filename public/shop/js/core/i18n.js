/**
 * Language, direction and every word on the site.
 *
 * Arabic is the DEFAULT, not the alternative: this shop sells in Egypt and the
 * overwhelming majority of its customers read Arabic first. English is the
 * fallback for a visitor who has explicitly asked for it.
 *
 * The Arabic here is written, not translated. Egyptian shoppers do not say
 * "أضف إلى عربة التسوق" out loud, and copy that reads like a machine wrote it
 * costs a small shop trust it cannot spare. Where the two languages want
 * different sentences, they get different sentences.
 */

const STORAGE_KEY = 'mm.shop.lang';

const dictionary = {
  en: {
    /*
     * The staging banner — see public/shared/deploymentBanner.js.
     *
     * Only ever drawn on a deployment that is NOT production, so these words
     * are never on a real shop's screen. `stagingTag` is also what goes in
     * front of the browser tab's title, which is why it is short.
     */
    stagingTag: 'Test shop', stagingHere: 'Test shop — an order placed here is not a real order',
    // --- chrome
    home: 'Home',
    search: 'Search',
    // Neutral on purpose, and only ever a last resort: the shop's own wording
    // arrives resolved in `config.branding.searchPlaceholder`, and a default
    // that named a product category is exactly how a clothes shop ended up
    // asking its customers to search for perfume.
    searchPlaceholder: 'Search products…',
    searchClose: 'Close search',
    cart: 'Cart',
    favorites: 'Favourites',
    trackOrder: 'Track order',
    menu: 'Menu',
    language: 'العربية',
    languageName: 'English',
    categories: 'Categories',
    brands: 'Brands',
    allProducts: 'All products',
    skipToContent: 'Skip to content',

    // --- home
    // The hero's own fallbacks, used only when the shop has written neither a
    // banner heading nor a tagline. True of a jeweller, a clothes shop and a
    // bookshop alike — nothing here may name what is being sold.
    heroTagline: 'Chosen piece by piece',
    heroBody: 'Everything on this page is in the shop today. Order it and pay the courier in cash when it reaches your door.',
    heroCta: 'Browse the shop',
    shopByCategory: 'Shop by category',
    ourBrands: 'Our brands',
    newArrivals: 'New arrivals',
    newArrivalsNote: 'The latest pieces to reach the shop',
    bestSellers: 'Best sellers',
    bestSellersNote: 'What our customers are buying most',
    viewAll: 'View all',
    itemsCount: (n) => `${n} ${n === 1 ? 'piece' : 'pieces'}`,

    // --- home: the trust row.
    // Three promises the shop is actually making, so every number in them comes
    // from the shop's own settings and none of them is written down here. The
    // delivery note has one wording per mode because a flat fee and a
    // percentage are different promises — the same split, and the same reason,
    // as the product page's `deliveryFlat` / `deliveryPercent*` above.
    trustDeliveryTitle: 'Delivery across Egypt',
    trustDeliveryFlat: (fee) => `${fee} to every governorate.`,
    trustDeliveryPercent: (percent) => `${percent}% of your order, to every governorate.`,
    trustDeliveryPercentMin: (percent, min) => `${percent}% of your order, ${min} minimum.`,
    trustDeliveryPercentMax: (percent, max) => `${percent}% of your order, ${max} at most.`,
    trustDeliveryPercentMinMax: (percent, min, max) => `${percent}% of your order, ${min} to ${max}.`,
    trustCodTitle: 'Cash on delivery',
    trustCodNote: 'You pay the courier at your door. No card, no transfer.',
    trustFreeTitle: 'Free delivery',
    trustFreeNote: (amount) => `On any order over ${amount}, delivery is on us.`,

    // --- listing
    sortBy: 'Sort by',
    sortNewest: 'Newest first',
    sortPriceAsc: 'Price: low to high',
    sortPriceDesc: 'Price: high to low',
    sortName: 'Name (A–Z)',
    resultsFor: (q) => `Results for “${q}”`,
    productsFound: (n) => (n === 1 ? '1 product' : `${n} products`),
    previous: 'Previous',
    next: 'Next',
    pageOf: (a, b) => `Page ${a} of ${b}`,

    // --- availability
    inStock: 'In stock',
    lowStock: 'Only a few left',
    outOfStock: 'Out of stock',

    // --- product
    brand: 'Brand',
    priceFrom: 'From',
    chooseVariant: 'Choose an option',
    quantity: 'Quantity',
    addToCart: 'Add to cart',
    addedToCart: 'Added to your cart',
    viewCart: 'View cart',
    aboutThisPiece: 'About this piece',
    deliveryTitle: 'Delivery & payment',
    deliveryFlat: (fee) => `Delivery ${fee} anywhere in Egypt.`,
    // Percent-mode delivery is a different promise from a flat fee, so it gets
    // its own sentence rather than reusing `deliveryFlat` with a "%" spliced
    // in — a minimum or a cap changes what the shopper should actually expect
    // to pay, and that has to be said, not implied.
    deliveryPercent: (percent) => `Delivery costs ${percent}% of your order, anywhere in Egypt.`,
    deliveryPercentMin: (percent, min) => `Delivery costs ${percent}% of your order, with a minimum charge of ${min}.`,
    deliveryPercentMax: (percent, max) => `Delivery costs ${percent}% of your order, capped at ${max}.`,
    deliveryPercentMinMax: (percent, min, max) => `Delivery costs ${percent}% of your order, between ${min} and ${max}.`,
    deliveryFreeOver: (amount) => `Delivery is free on orders over ${amount}.`,
    codShort: 'Cash on delivery — you pay when it arrives.',
    unavailableVariant: 'This option is out of stock',
    moreImages: 'More photos',
    // Said once, at the moment the stepper stops, rather than at checkout.
    onlyNLeft: (n) => `Only ${n} left`,

    // --- cart
    yourCart: 'Your cart',
    cartEmptyTitle: 'Your cart is empty',
    cartEmptyBody: 'Have a look around and add whatever catches your eye.',
    continueShopping: 'Continue shopping',
    remove: 'Remove',
    increase: 'Add one',
    decrease: 'Remove one',
    subtotal: 'Subtotal',
    vat: 'VAT',
    delivery: 'Delivery',
    free: 'Free',
    total: 'Total',
    spendMoreForFree: (amount) => `Add ${amount} more and delivery is on us.`,
    freeDeliveryEarned: 'You have earned free delivery.',
    goToCheckout: 'Checkout',
    eachPrice: 'each',
    cartAdjusted: 'We have fewer of something than when you added it, so we have adjusted your cart to what is left.',

    // --- favourites
    // The list itself is only product ids in this browser's storage — nothing
    // is saved to an account, because there are no accounts. The wording says
    // "saved", never "your account".
    yourFavorites: 'Your favourites',
    addToFavorites: 'Save to favourites',
    removeFromFavorites: 'Remove from favourites',
    favoritesEmptyTitle: 'Nothing saved yet',
    favoritesEmptyBody: 'Tap the heart on anything you like and it will be waiting for you here.',
    footerFavorites: 'Favourites',
    // Un-hearting on the favourites page takes the card off the page, so it is
    // said out loud and it is undoable — a heart is one tap, and one tap is
    // the easiest thing in the world to do by accident on a phone.
    favoriteRemoved: 'Removed from your favourites',
    undo: 'Undo',
    // What the shop has taken down since it was hearted. Said plainly, because
    // a list that quietly shrinks between two visits looks like a bug in us.
    favoritesGone: (n) => (n === 1
      ? 'One of your saved pieces is no longer available, so we have taken it off the list.'
      : `${n} of your saved pieces are no longer available, so we have taken them off the list.`),

    // --- checkout
    checkout: 'Checkout',
    yourDetails: 'Your details',
    fullName: 'Full name',
    phone: 'Phone number',
    phoneHint: 'We call this number to confirm your order.',
    email: 'Email',
    optional: 'optional',
    deliveryAddress: 'Delivery address',
    city: 'City / governorate',
    area: 'Area or district',
    addressLine: 'Street, building, floor and flat',
    addressNotes: 'Notes for the courier',
    addressNotesHint: 'A landmark, a gate number, the best time to ring.',
    orderNote: 'Anything you want us to know',
    paymentTitle: 'Payment',
    cashOnDelivery: 'Cash on delivery',
    codLong: 'You pay the courier in cash when your order reaches you. We never ask for card details — there is nowhere on this site to enter them.',
    orderSummary: 'Order summary',
    placeOrder: 'Place order',
    placingOrder: 'Placing your order…',
    requiredField: 'Please fill this in',
    invalidPhone: 'Please enter a valid phone number',
    invalidEmail: 'Please check this email address',
    orderFailed: 'We could not place your order',
    lineSoldOut: 'One of the pieces in your basket has just sold out, so we have taken it out. Please check what is left and try again.',

    // --- success
    thankYou: 'Thank you — your order is in.',
    orderNumber: 'Order number',
    keepThisNumber: 'Keep this number. You will need it, together with your phone number, to track your order.',
    weWillCall: 'We will call you shortly on the number you gave us to confirm everything.',
    payOnDelivery: (amount) => `Please have ${amount} ready in cash for the courier.`,
    trackThisOrder: 'Track this order',
    backToShop: 'Back to the shop',

    // --- tracking
    trackTitle: 'Track your order',
    trackIntro: 'Enter your order number and the phone number you ordered with.',
    orderNumberLabel: 'Order number',
    trackButton: 'Find my order',
    tracking: 'Looking…',
    orderNotFound: 'We could not find an order with that number and that phone number. Check both and try again.',
    statusPending: 'New',
    statusPendingNote: 'We have your order and we will call you shortly to confirm it.',
    statusAccepted: 'Accepted',
    statusAcceptedNote: 'We have accepted your order and are getting it ready.',
    statusOutForDelivery: 'Out for delivery',
    statusOutForDeliveryNote: 'Your order is with the courier. Please have the cash ready.',
    statusDelivered: 'Delivered',
    statusDeliveredNote: 'Your order has arrived and has been paid for. Thank you.',
    statusNotReceived: 'Not received',
    statusNotReceivedNote: 'The courier could not hand your order over, so it came back to us. Call us and we will send it out again.',
    statusCancelled: 'Cancelled',
    statusCancelledNote: 'This order was cancelled and nothing was charged.',
    orderProgress: 'Where your order is',
    stepDone: 'Done',
    stepNow: 'Now',
    endedReason: 'Reason',
    placedOn: 'Placed on',
    items: 'Items',
    deliveringTo: 'Delivering to',

    // --- states
    loading: 'Loading…',
    nothingHere: 'Nothing here yet',
    nothingHereBody: 'There are no products in this part of the shop at the moment.',
    noResultsTitle: 'No matches',
    noResultsBody: 'We could not find anything for that search. Try a shorter word.',
    errorTitle: 'Something went wrong',
    errorBody: 'We could not reach the shop. Check your connection and try again.',
    retry: 'Try again',
    notFoundTitle: 'This page does not exist',
    notFoundBody: 'The link may be old, or the piece may have sold out and been taken down.',
    productGoneTitle: 'This piece is no longer available',
    closedTitle: 'We are closed right now',
    closedBody: 'Our online shop is taking a short break. Please check back soon — or message us and we will help.',

    // --- footer
    whatsappUs: 'Message us on WhatsApp',
    footerShop: 'Shop',
    footerHelp: 'Help',
    rightsReserved: 'All rights reserved.',
    payWithCash: 'Cash on delivery across Egypt',
    followUs: 'Follow us',

    // --- contact
    contactUs: 'Contact us',
    contactTitle: 'Get in touch',
    contactIntro: 'Whichever way suits you — we are happy to hear from you.',
    contactEmail: 'Email',
    contactPhone: 'Phone',
    contactWhatsapp: 'WhatsApp',
    contactAddress: 'Address',
    contactHours: 'Opening hours',
    contactMap: 'Location',
    contactMapCta: 'Open in Maps',
    contactEmptyTitle: 'No contact details yet',
    contactEmptyBody: 'This shop has not added a way to reach it here yet.',

    /*
     * --- what a page says about itself
     *
     * The `<title>`, the meta description and the Open Graph card. These are
     * here, with every other sentence on the site, because the SERVER writes
     * them into the HTML before any script runs (see
     * src/services/StorefrontSeo.js) and the browser rewrites them as the
     * customer moves between pages. Two places that say it, one place it is
     * written — otherwise the sentence a shared link arrives wearing and the
     * sentence the page settles on would drift apart, and only one of them is
     * ever looked at by the person who notices.
     *
     * Nothing here names a shop: the name is always an argument.
     */
    metaTitle: (title, shop) => `${title} — ${shop}`,
    metaProduct: (name, shop) => `${name} — available now at ${shop}. Cash on delivery across Egypt.`,
    metaListing: (title, shop) => `Browse ${title} at ${shop} — cash on delivery across Egypt.`,
  },

  ar: {
    // The staging banner — see public/shared/deploymentBanner.js.
    stagingTag: 'متجر تجريبي', stagingHere: 'متجر تجريبي — أي طلب هنا ليس طلبًا حقيقيًا',
    // --- chrome
    home: 'الرئيسية',
    search: 'بحث',
    searchPlaceholder: 'ابحث عن المنتجات…',
    searchClose: 'إغلاق البحث',
    cart: 'السلة',
    favorites: 'المفضلة',
    trackOrder: 'تتبّع طلبك',
    menu: 'القائمة',
    language: 'English',
    languageName: 'العربية',
    categories: 'الأقسام',
    brands: 'الماركات',
    allProducts: 'كل المنتجات',
    skipToContent: 'تخطَّ إلى المحتوى',

    // --- home
    heroTagline: 'مختارة قطعة قطعة',
    heroBody: 'كل اللي في الصفحة دي موجود في المحل النهاردة. اطلبه وادفع كاش للمندوب لما يوصل لحد باب البيت.',
    heroCta: 'اتفرّج على المنتجات',
    shopByCategory: 'تسوّق حسب القسم',
    ourBrands: 'ماركاتنا',
    newArrivals: 'وصل حديثًا',
    newArrivalsNote: 'أحدث القطع اللي نزلت المحل',
    bestSellers: 'الأكثر مبيعًا',
    bestSellersNote: 'اللي عملاؤنا بيشتروه أكتر',
    viewAll: 'اعرض الكل',
    itemsCount: (n) => (n === 1 ? 'قطعة واحدة' : n === 2 ? 'قطعتان' : n <= 10 ? `${n} قطع` : `${n} قطعة`),

    // --- الصف اللي تحت المنتجات: وعود المحل التلاتة. كل رقم فيها جاي من
    // إعدادات المحل نفسه — مفيش رقم واحد مكتوب هنا. ونوتة التوصيل ليها صيغة
    // لكل وضع، لأن الرسم الثابت غير النسبة، بنفس منطق `deliveryFlat` /
    // `deliveryPercent*` اللي فوق.
    trustDeliveryTitle: 'توصيل لكل مصر',
    trustDeliveryFlat: (fee) => `${fee} لكل المحافظات.`,
    trustDeliveryPercent: (percent) => `${percent}٪ من قيمة طلبك، لكل المحافظات.`,
    trustDeliveryPercentMin: (percent, min) => `${percent}٪ من قيمة طلبك، بحد أدنى ${min}.`,
    trustDeliveryPercentMax: (percent, max) => `${percent}٪ من قيمة طلبك، بحد أقصى ${max}.`,
    trustDeliveryPercentMinMax: (percent, min, max) => `${percent}٪ من قيمة طلبك، من ${min} لحد ${max}.`,
    trustCodTitle: 'الدفع عند الاستلام',
    trustCodNote: 'بتدفع للمندوب على الباب. من غير بطاقة ولا تحويل.',
    trustFreeTitle: 'توصيل مجاني',
    trustFreeNote: (amount) => `أي طلب فوق ${amount} والتوصيل علينا.`,

    // --- listing
    sortBy: 'الترتيب',
    sortNewest: 'الأحدث أولًا',
    sortPriceAsc: 'السعر: من الأقل للأعلى',
    sortPriceDesc: 'السعر: من الأعلى للأقل',
    sortName: 'الاسم (أ–ي)',
    resultsFor: (q) => `نتائج البحث عن «${q}»`,
    productsFound: (n) => (n === 1 ? 'منتج واحد' : n === 2 ? 'منتجان' : n <= 10 ? `${n} منتجات` : `${n} منتجًا`),
    previous: 'السابق',
    next: 'التالي',
    pageOf: (a, b) => `صفحة ${a} من ${b}`,

    // --- availability
    inStock: 'متوفر',
    lowStock: 'باقي كمية قليلة',
    outOfStock: 'غير متوفر',

    // --- product
    brand: 'الماركة',
    priceFrom: 'يبدأ من',
    chooseVariant: 'اختار النوع',
    quantity: 'الكمية',
    addToCart: 'أضف إلى السلة',
    addedToCart: 'تمت الإضافة إلى السلة',
    viewCart: 'شوف السلة',
    aboutThisPiece: 'عن القطعة دي',
    deliveryTitle: 'التوصيل والدفع',
    deliveryFlat: (fee) => `التوصيل ${fee} لكل محافظات مصر.`,
    // وضع النسبة وعد مختلف عن الرسم الثابت، فمحتاج جملة خاصة بيه — لو فيه حد
    // أدنى أو أقصى للتوصيل، العميل لازم يعرفه قبل ما يوصل للسلة.
    deliveryPercent: (percent) => `الشحن ${percent}٪ من قيمة طلبك، لكل محافظات مصر.`,
    deliveryPercentMin: (percent, min) => `الشحن ${percent}٪ من قيمة طلبك، بحد أدنى ${min}.`,
    deliveryPercentMax: (percent, max) => `الشحن ${percent}٪ من قيمة طلبك، بحد أقصى ${max}.`,
    deliveryPercentMinMax: (percent, min, max) => `الشحن ${percent}٪ من قيمة طلبك، من ${min} لحد ${max}.`,
    deliveryFreeOver: (amount) => `التوصيل مجاني للطلبات فوق ${amount}.`,
    codShort: 'الدفع عند الاستلام — تدفع لما الطلب يوصلك.',
    unavailableVariant: 'النوع ده مش متوفر حاليًا',
    moreImages: 'صور أكتر',
    onlyNLeft: (n) => (n === 1 ? 'متبقي قطعة واحدة بس'
      : n === 2 ? 'متبقي قطعتين بس'
        : n <= 10 ? `متبقي ${n} قطع بس`
          : `متبقي ${n} قطعة بس`),

    // --- cart
    yourCart: 'سلة مشترياتك',
    cartEmptyTitle: 'السلة فاضية',
    cartEmptyBody: 'اتفرّج على المنتجات وضيف اللي يعجبك.',
    continueShopping: 'كمّل تسوّق',
    remove: 'إزالة',
    increase: 'زوّد واحد',
    decrease: 'قلّل واحد',
    subtotal: 'إجمالي المنتجات',
    vat: 'ضريبة القيمة المضافة',
    delivery: 'التوصيل',
    free: 'مجاني',
    total: 'الإجمالي',
    spendMoreForFree: (amount) => `ضيف ${amount} كمان ويبقى التوصيل علينا.`,
    freeDeliveryEarned: 'التوصيل عليك مجاني.',
    goToCheckout: 'إتمام الطلب',
    eachPrice: 'للقطعة',
    cartAdjusted: 'الكمية المتاحة قلّت من ساعة ما ضفت، فظبطنا السلة على اللي متبقي.',

    // --- المفضلة
    // القايمة نفسها مجرد أرقام منتجات محفوظة في المتصفح ده — مفيش حساب ولا
    // تسجيل دخول، فالكلام كله عن "حفظت" مش عن "حسابك".
    yourFavorites: 'المفضلة بتاعتك',
    addToFavorites: 'ضيفه للمفضلة',
    removeFromFavorites: 'شيله من المفضلة',
    favoritesEmptyTitle: 'لسه مفيش حاجة في المفضلة',
    favoritesEmptyBody: 'دوس على القلب اللي على أي قطعة تعجبك وهتلاقيها مستنياك هنا.',
    footerFavorites: 'المفضلة',
    favoriteRemoved: 'اتشالت من المفضلة',
    undo: 'رجّعها',
    // العدد بيغيّر الجملة نفسها في العربي، مش بس الرقم اللي جواها.
    favoritesGone: (n) => {
      if (n === 1) return 'فيه قطعة من اللي حافظها ما بقتش متاحة، فشِلناها من القايمة.';
      if (n === 2) return 'فيه قطعتين من اللي حافظهم ما بقوش متاحين، فشِلناهم من القايمة.';
      if (n <= 10) return `فيه ${n} قطع من اللي حافظهم ما بقوش متاحين، فشِلناهم من القايمة.`;
      return `فيه ${n} قطعة من اللي حافظهم ما بقوش متاحين، فشِلناهم من القايمة.`;
    },

    // --- checkout
    checkout: 'إتمام الطلب',
    yourDetails: 'بياناتك',
    fullName: 'الاسم بالكامل',
    phone: 'رقم الموبايل',
    phoneHint: 'هنكلمك على الرقم ده عشان نأكد الطلب.',
    email: 'البريد الإلكتروني',
    optional: 'اختياري',
    deliveryAddress: 'عنوان التوصيل',
    city: 'المحافظة أو المدينة',
    area: 'المنطقة أو الحي',
    addressLine: 'الشارع والعمارة والدور والشقة',
    addressNotes: 'ملاحظات للمندوب',
    addressNotesHint: 'علامة مميزة، رقم البوابة، أنسب وقت للاتصال.',
    orderNote: 'أي حاجة تحب تقولها لنا',
    paymentTitle: 'الدفع',
    cashOnDelivery: 'الدفع عند الاستلام',
    codLong: 'بتدفع كاش للمندوب لما الطلب يوصلك. إحنا مش بنطلب بيانات أي بطاقة — ومفيش مكان في الموقع أصلًا تكتبها فيه.',
    orderSummary: 'ملخص الطلب',
    placeOrder: 'أكّد الطلب',
    placingOrder: 'بنسجّل طلبك…',
    requiredField: 'الخانة دي مطلوبة',
    invalidPhone: 'اكتب رقم موبايل صحيح',
    invalidEmail: 'راجع البريد الإلكتروني ده',
    orderFailed: 'معرفناش نسجّل طلبك',
    lineSoldOut: 'واحدة من القطع اللي في سلتك خلصت دلوقتي، فشِلناها من السلة. راجع الباقي وحاول تاني.',

    // --- success
    thankYou: 'شكرًا — طلبك وصلنا.',
    orderNumber: 'رقم الطلب',
    keepThisNumber: 'احتفظ بالرقم ده. هتحتاجه مع رقم موبايلك عشان تتابع طلبك.',
    weWillCall: 'هنكلمك قريّب على الرقم اللي كتبته عشان نأكد كل حاجة.',
    payOnDelivery: (amount) => `جهّز ${amount} كاش للمندوب لو سمحت.`,
    trackThisOrder: 'تابع الطلب ده',
    backToShop: 'ارجع للمتجر',

    // --- tracking
    trackTitle: 'تابع طلبك',
    trackIntro: 'اكتب رقم الطلب ورقم الموبايل اللي طلبت بيه.',
    orderNumberLabel: 'رقم الطلب',
    trackButton: 'دوّر على طلبي',
    tracking: 'بندوّر…',
    orderNotFound: 'مالقيناش طلب بالرقم ده مع رقم الموبايل ده. راجع الاتنين وحاول تاني.',
    statusPending: 'جديد',
    statusPendingNote: 'استلمنا طلبك وهنكلمك حالًا عشان نأكده.',
    statusAccepted: 'تم القبول',
    statusAcceptedNote: 'قبلنا طلبك وبنجهّزه.',
    statusOutForDelivery: 'قيد التوصيل',
    statusOutForDeliveryNote: 'طلبك مع المندوب. جهّز الفلوس كاش لو سمحت.',
    statusDelivered: 'تم التسليم',
    statusDeliveredNote: 'طلبك وصلك واتدفع. شكرًا ليك.',
    statusNotReceived: 'لم يتم الاستلام',
    statusNotReceivedNote: 'المندوب مقدرش يسلّمك الطلب ورجع بيه تاني. كلمنا وهنبعته لك من جديد.',
    statusCancelled: 'ملغي',
    statusCancelledNote: 'الطلب ده اتلغى ومحصلناش منك أي فلوس.',
    orderProgress: 'طلبك وصل لفين',
    stepDone: 'تم',
    stepNow: 'دلوقتي',
    endedReason: 'السبب',
    placedOn: 'تاريخ الطلب',
    items: 'المنتجات',
    deliveringTo: 'التوصيل إلى',

    // --- states
    loading: 'جاري التحميل…',
    nothingHere: 'مفيش حاجة هنا لسه',
    nothingHereBody: 'مفيش منتجات في الجزء ده من المتجر حاليًا.',
    noResultsTitle: 'مفيش نتائج',
    noResultsBody: 'مالقيناش حاجة بالبحث ده. جرّب كلمة أقصر.',
    errorTitle: 'في حاجة مش مظبوطة',
    errorBody: 'معرفناش نوصل للمتجر. اطمن على النت وحاول تاني.',
    retry: 'حاول تاني',
    notFoundTitle: 'الصفحة دي مش موجودة',
    notFoundBody: 'يمكن يكون اللينك قديم، أو القطعة خلصت واتشالت من المتجر.',
    productGoneTitle: 'القطعة دي مابقتش متاحة',
    closedTitle: 'المتجر مقفول دلوقتي',
    closedBody: 'المتجر الإلكتروني واخد بريك صغير. تعالى لنا تاني قريب — أو ابعتلنا رسالة وإحنا تحت أمرك.',

    // --- footer
    whatsappUs: 'كلّمنا على واتساب',
    footerShop: 'المتجر',
    footerHelp: 'مساعدة',
    rightsReserved: 'كل الحقوق محفوظة.',
    payWithCash: 'الدفع عند الاستلام في كل مصر',
    followUs: 'تابعنا',

    // --- contact
    contactUs: 'تواصل معانا',
    contactTitle: 'تواصل معانا',
    contactIntro: 'بأي طريقة تريحك — يهمنا نسمع منك.',
    contactEmail: 'البريد الإلكتروني',
    contactPhone: 'التليفون',
    contactWhatsapp: 'واتساب',
    contactAddress: 'العنوان',
    contactHours: 'مواعيد العمل',
    contactMap: 'الموقع',
    contactMapCta: 'افتح على الخريطة',
    contactEmptyTitle: 'لسه مفيش بيانات تواصل',
    contactEmptyBody: 'المحل ده لسه ما ضافش طريقة يتواصل بيها هنا.',

    // --- الكلام اللي الصفحة بتقوله عن نفسها: العنوان والوصف وكارت المشاركة.
    // مكتوب هنا مع باقي كلام الموقع لأن السيرفر هو اللي بيكتبه في الـ HTML قبل
    // ما أي سكريبت يشتغل، والمتصفح بيحدّثه بعد كده — نص واحد، مش نسختين.
    metaTitle: (title, shop) => `${title} — ${shop}`,
    metaProduct: (name, shop) => `${name} — متاح دلوقتي في ${shop}. الدفع عند الاستلام في كل مصر.`,
    metaListing: (title, shop) => `اتفرّج على ${title} في ${shop} — الدفع عند الاستلام في كل مصر.`,
  },
};

/**
 * Arabic wins on first visit. `localStorage` is read defensively because
 * private-browsing modes on iOS have historically thrown on access, and a
 * storage quirk must not take the whole shop down before it paints.
 */
function readStored() {
  try {
    // `globalThis.localStorage` rather than `window.`: this module is imported
    // by Node too (see the note on `translate` below), where there is no window
    // at all and a bare reference would throw before the dictionary exists.
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    return saved === 'en' || saved === 'ar' ? saved : null;
  } catch {
    return null;
  }
}

let language = readStored() || 'ar';
const listeners = new Set();

export const getLanguage = () => language;
export const isRtl = () => language === 'ar';
export const onLanguageChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export function setLanguage(next) {
  const value = next === 'en' ? 'en' : 'ar';
  if (value === language) return;
  language = value;
  try { window.localStorage.setItem(STORAGE_KEY, value); } catch { /* storage is a nicety */ }
  applyDocumentLanguage();
  listeners.forEach((fn) => fn(value));
}

/** `dir` on `<html>` is what makes every logical CSS property mirror itself. */
export function applyDocumentLanguage() {
  const root = document.documentElement;
  root.lang = language;
  root.dir = isRtl() ? 'rtl' : 'ltr';
}

/**
 * `t('key')` for plain strings, `t('key', arg)` for the ones that need a value
 * spliced in. Those are functions rather than `{0}` placeholders because Arabic
 * plurals do not survive string interpolation — "3 قطع" and "13 قطعة" are not
 * the same sentence with a different number in it.
 */
export function t(key, ...args) {
  return translate(language, key, ...args);
}

/**
 * The same words, for a language that is not this browser's.
 *
 * This is what lets the SERVER render the `<head>` — the title, the description
 * and the Open Graph card that a WhatsApp preview shows — out of this exact
 * dictionary instead of a second copy of it in `src/`. Node cannot use `t()`,
 * because `t()` reads a module-level language that only a browser sets; it can
 * use this, because the language is an argument.
 *
 * There is no build step and there never will be, so nothing is generated or
 * duplicated: `src/services/StorefrontSeo.js` imports this file directly. The
 * storefront cannot import from `src/` — a browser has no access to it — but
 * Node reading a plain ES module out of `public/` works exactly as it looks
 * like it should, and it is the only arrangement where the sentence a shared
 * link arrives wearing and the sentence the page settles on cannot drift.
 */
export function translate(lang, key, ...args) {
  const entry = dictionary[lang]?.[key] ?? dictionary.en[key];
  if (typeof entry === 'function') return entry(...args);
  return entry ?? key;
}

/** Pick the right side of a bilingual record, falling back rather than blanking. */
export function pick(row, field = 'name') {
  return pickIn(language, row, field);
}

/** `pick`, for a language given rather than assumed — the server's half. */
export function pickIn(lang, row, field = 'name') {
  if (!row) return '';
  const wanted = row[`${field}_${lang}`];
  const other = row[`${field}_${lang === 'ar' ? 'en' : 'ar'}`];
  return (wanted && String(wanted).trim()) || (other && String(other).trim()) || '';
}
