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
    // --- chrome
    home: 'Home',
    search: 'Search',
    searchPlaceholder: 'Search bags, perfumes, jewellery…',
    searchClose: 'Close search',
    cart: 'Cart',
    trackOrder: 'Track order',
    menu: 'Menu',
    language: 'العربية',
    languageName: 'English',
    categories: 'Categories',
    brands: 'Brands',
    allProducts: 'All products',
    skipToContent: 'Skip to content',

    // --- home
    heroTagline: 'Bags, perfume and jewellery — chosen piece by piece',
    heroBody: 'Everything on this page is in our Cairo shop today. Order it and pay the courier in cash when it reaches your door.',
    heroCta: 'Browse the shop',
    shopByCategory: 'Shop by category',
    ourBrands: 'Our brands',
    newArrivals: 'New arrivals',
    newArrivalsNote: 'The latest pieces to reach the shop',
    bestSellers: 'Best sellers',
    bestSellersNote: 'What our customers are buying most',
    viewAll: 'View all',
    itemsCount: (n) => `${n} ${n === 1 ? 'piece' : 'pieces'}`,

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
    deliveryFreeOver: (amount) => `Delivery is free on orders over ${amount}.`,
    codShort: 'Cash on delivery — you pay when it arrives.',
    unavailableVariant: 'This option is out of stock',
    moreImages: 'More photos',

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
    statusPending: 'Waiting for confirmation',
    statusPendingNote: 'We have your order and will call you to confirm it.',
    statusConfirmed: 'Confirmed',
    statusConfirmedNote: 'Your order is being prepared for delivery.',
    statusDelivered: 'Delivered',
    statusDeliveredNote: 'This order has been delivered. Thank you.',
    statusCancelled: 'Cancelled',
    statusCancelledNote: 'This order was cancelled.',
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
    footerAbout: 'A small accessories shop in Cairo. Everything we list is a piece we actually keep.',
    footerShop: 'Shop',
    footerHelp: 'Help',
    rightsReserved: 'All rights reserved.',
    payWithCash: 'Cash on delivery across Egypt',
  },

  ar: {
    // --- chrome
    home: 'الرئيسية',
    search: 'بحث',
    searchPlaceholder: 'دوّر على شنطة أو عطر أو مجوهرات…',
    searchClose: 'إغلاق البحث',
    cart: 'السلة',
    trackOrder: 'تتبّع طلبك',
    menu: 'القائمة',
    language: 'English',
    languageName: 'العربية',
    categories: 'الأقسام',
    brands: 'الماركات',
    allProducts: 'كل المنتجات',
    skipToContent: 'تخطَّ إلى المحتوى',

    // --- home
    heroTagline: 'شنط وعطور ومجوهرات — مختارة قطعة قطعة',
    heroBody: 'كل اللي في الصفحة دي موجود في محلنا في القاهرة النهاردة. اطلبه وادفع كاش للمندوب لما يوصل لحد باب البيت.',
    heroCta: 'اتفرّج على المنتجات',
    shopByCategory: 'تسوّق حسب القسم',
    ourBrands: 'ماركاتنا',
    newArrivals: 'وصل حديثًا',
    newArrivalsNote: 'أحدث القطع اللي نزلت المحل',
    bestSellers: 'الأكثر مبيعًا',
    bestSellersNote: 'اللي عملاؤنا بيشتروه أكتر',
    viewAll: 'اعرض الكل',
    itemsCount: (n) => (n === 1 ? 'قطعة واحدة' : n === 2 ? 'قطعتان' : n <= 10 ? `${n} قطع` : `${n} قطعة`),

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
    deliveryFreeOver: (amount) => `التوصيل مجاني للطلبات فوق ${amount}.`,
    codShort: 'الدفع عند الاستلام — تدفع لما الطلب يوصلك.',
    unavailableVariant: 'النوع ده مش متوفر حاليًا',
    moreImages: 'صور أكتر',

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
    statusPending: 'في انتظار التأكيد',
    statusPendingNote: 'استلمنا طلبك وهنكلمك عشان نأكده.',
    statusConfirmed: 'تم التأكيد',
    statusConfirmedNote: 'بنجهّز طلبك للتوصيل.',
    statusDelivered: 'تم التسليم',
    statusDeliveredNote: 'الطلب ده اتسلّم. شكرًا ليك.',
    statusCancelled: 'ملغي',
    statusCancelledNote: 'الطلب ده اتلغى.',
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
    footerAbout: 'محل إكسسوارات صغير في القاهرة. كل اللي معروض عندنا قطع موجودة فعلًا.',
    footerShop: 'المتجر',
    footerHelp: 'مساعدة',
    rightsReserved: 'كل الحقوق محفوظة.',
    payWithCash: 'الدفع عند الاستلام في كل مصر',
  },
};

/**
 * Arabic wins on first visit. `localStorage` is read defensively because
 * private-browsing modes on iOS have historically thrown on access, and a
 * storage quirk must not take the whole shop down before it paints.
 */
function readStored() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
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
  const entry = dictionary[language]?.[key] ?? dictionary.en[key];
  if (typeof entry === 'function') return entry(...args);
  return entry ?? key;
}

/** Pick the right side of a bilingual record, falling back rather than blanking. */
export function pick(row, field = 'name') {
  if (!row) return '';
  const wanted = row[`${field}_${language}`];
  const other = row[`${field}_${language === 'ar' ? 'en' : 'ar'}`];
  return (wanted && String(wanted).trim()) || (other && String(other).trim()) || '';
}
