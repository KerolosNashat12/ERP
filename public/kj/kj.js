/**
 * KJ — the landing page. Language, theme, reveal, and the one form on it.
 *
 * WHAT THIS FILE IS NOT: it is not the page. `index.html` ships the whole
 * landing page in Arabic, already written out, so a visitor whose connection
 * loses this module — or who has JavaScript off entirely — still gets the
 * offer, the three prices, the phone number and the WhatsApp link. Everything
 * below is an ENHANCEMENT on top of a page that already works:
 *
 *   1. English. One dictionary, one `t()`, one toggle, persisted, with `lang`
 *      and `dir` set from it — the same shape as `public/shop/js/core/i18n.js`,
 *      which is the pattern this codebase already uses.
 *   2. The palette, derived from ONE hex by `public/shared/brandTheme.js`
 *      rather than written out as shades by hand.
 *   3. Reveal-on-scroll, which only ever exists when this file runs.
 *   4. The demo form, which composes a WhatsApp message out of what the
 *      visitor typed. With this file gone the same form still submits — see
 *      `wireDemoForm` — it just arrives without the answers in it.
 *
 * No framework, no build step, no third party. Same rules as the ERP, the
 * storefront and KJ Admin.
 */

import { applyTheme, monogramFavicon } from '../shared/brandTheme.js';

/**
 * KJ's own colour: the indigo KJ Admin already wears. ONE hex — every shade
 * the sheet paints with is derived from it by `brandTheme.js`, exactly as a
 * shop's colour is derived on the storefront. The literals in `kj.css`'s
 * `:root` are the same values, generated from this hex, and they are there for
 * one reason: they are what the page wears before this module lands.
 */
const ACCENT = '#4f46e5';

const STORAGE_KEY = 'kj.lang';

/** WhatsApp, in the shape wa.me wants it: country code, no plus, no spaces. */
const WHATSAPP = '201552526142';

// =========================================================================
// THE DICTIONARY
//
// Both languages, in one place. The Arabic is the approved copy — Egyptian,
// written for Egyptian shop owners rather than translated into them — and the
// English beside it is the approved English, not a rendering of the Arabic.
// Neither side is generated from the other.
//
// Every key here appears in `index.html` as `data-i18n="key"` (or
// `data-i18n-alt` / `data-i18n-label` / `data-i18n-placeholder` for an
// attribute), and the Arabic already sits in the document as text. This
// dictionary is what the toggle swaps IN; it is not what paints the first
// screen.
// =========================================================================

const dictionary = {
  ar: {
    // --- document
    pageTitle: 'KJ — نظام إدارة محلات وموقع بيع أونلاين في مصر',
    metaDescription: 'امسك مخزنك ومبيعاتك وافتح موقع بيع أونلاين باسم محلك، من منصة واحدة بالعربي. باقات من ٢٬٠٠٠ جنيه شهريًا.',

    // --- chrome. Not from the copy file: a skip link and the name of the
    // other language are furniture, and the storefront's own wording for them
    // is reused here rather than invented twice.
    skipToContent: 'تخطَّ إلى المحتوى',
    langSwitch: 'English',
    langSwitchLabel: 'Switch to English',
    navLabel: 'روابط الصفحة',
    footNavLabel: 'روابط التذييل',
    navPackages: 'الباقات',
    navDemo: 'اطلب عرض توضيحي',
    navContact: 'كلّمنا',

    // --- 1 · hero
    heroEyebrow: 'نظام إدارة محلات وبيع أونلاين — مصري ١٠٠٪',
    heroTitle: 'إدارة محلك ومبيعاتك من مكان واحد',
    heroSub: 'مخزن، كاشير، فواتير، تقارير، وموقع بيع أونلاين — كله في منصة واحدة بتشتغل بالعربي، وسهلة لدرجة إن أي حد في المحل يقدر يستخدمها من أول يوم.',
    heroPrimary: 'اطلب عرض توضيحي',
    heroSecondary: 'شوف الباقات والأسعار',
    trust1: 'بيشتغل من غير نت في المحل',
    trust2: 'عربي وإنجليزي بالكامل',
    trust3: 'تركيب وتدريب من غير أي رسوم إضافية',

    // --- 2 · business overview
    overviewTitle: 'محلك شغّال… بس شغلك مش متجمّع في مكان واحد',
    overviewIntro: 'أغلب أصحاب المحلات في مصر بيمسكوا المخزن في كشكول، المبيعات في تليفون، والطلبات أونلاين في رسايل واتساب. كل حاجة شغالة، بس محدش يعرف بالظبط باع كام، ولا فاضل كام، ولا إيه اللي بيجيب فلوس فعلًا. KJ بيجمع ده كله في منصة واحدة.',
    block1Title: 'بِع واحسب في ثانية',
    block1Body: 'افتح شاشة الكاشير، امسح الباركود، والفاتورة تطلع. المخزون بيتخصم لوحده، والوردية بتتقفل في آخر اليوم بأرقام صح من غير حسبة على ورق.',
    block2Title: 'اعرف مخزنك بالظبط',
    block2Body: 'كل صنف بمقاساته وألوانه وسعره وباركود خاص بيه. اطبع ملصقات باركود بنفسك، اعمل جرد، وشوف اللي قرب يخلص قبل ما العميل يسألك عليه.',
    block3Title: 'وسّع وابيع أونلاين',
    block3Body: 'بضغطة واحدة يبقى عندك موقع بيع باسم محلك، بلوجو وألوانك، والدفع عند الاستلام. الطلب اللي بييجي من الموقع بيدخل على نفس النظام — نفس المخزون، نفس الفواتير، نفس التقارير.',
    overviewClose: 'محل واحد أو خمسة، وأونلاين وأوفلاين — نفس الأرقام، ومكان واحد بتتفرج منه على كل حاجة.',

    // --- 3 · packages
    packagesTitle: 'باقات واضحة، من غير مفاجآت',
    packagesSub: 'كل الباقات شاملة التركيب والتدريب والتحديثات. من غير عقد سنة، تقدر تغيّر باقتك أو توقف في أي وقت.',

    p1Name: 'البداية',
    p1Price: '٢٬٠٠٠ جنيه',
    p1Period: '/ شهريًا',
    p1Line: 'للمحل الواحد اللي عايز يمسك مخزنه ومبيعاته صح',
    p1f1: 'شاشة كاشير كاملة مع دعم قارئ الباركود',
    p1f2: 'إدارة المخزون: أصناف، مقاسات وألوان، وتنبيه لما الكمية تقرب تخلص',
    p1f3: 'فواتير ومرتجعات وتقفيل وردية يومي',
    p1f4: 'تقارير المبيعات الأساسية: إيه اللي بيتباع وإيه اللي واقف',
    p1f5: 'مستخدمين اتنين (صاحب المحل + كاشير)',
    p1Cta: 'ابدأ بالبداية',

    p2Name: 'التوسّع',
    p2Price: '٣٬٥٠٠ جنيه',
    p2Period: '/ شهريًا',
    p2Badge: 'الأكثر طلبًا',
    p2Line: 'لما تبقى عايز تبيع أونلاين من غير ما تسيب المحل',
    p2f1: 'كل اللي في باقة البداية، وكمان:',
    p2f2: 'موقع بيع أونلاين باسم محلك، بلوجو وألوانك، عربي وإنجليزي',
    p2f3: 'الدفع عند الاستلام وشحن بتحدده إنت (مبلغ ثابت أو نسبة من الطلب)',
    p2f4: 'طلبات الموقع بتدخل على نفس النظام وبتخصم من نفس المخزون',
    p2f5: 'طباعة ملصقات باركود بنفسك',
    p2f6: '٥ مستخدمين بصلاحيات مختلفة',
    p2Cta: 'ابدأ التوسّع',

    p3Name: 'الاحترافية',
    p3Price: '٦٬٠٠٠ جنيه',
    p3Period: '/ شهريًا',
    p3Line: 'لأكتر من فرع، ولما تحب تشوف كل محلاتك من شاشة واحدة',
    p3f1: 'كل اللي في باقة التوسّع، وكمان:',
    p3f2: 'فروع ومحلات متعددة، كل واحد ببياناته ولوجوه وموقعه',
    p3f3: 'لوحة KJ Admin: كل محلاتك، مبيعاتها ومستخدميها، في شاشة واحدة',
    p3f4: 'مستخدمين بلا حد، وصلاحيات بتحددها بالتفصيل لكل موظف',
    p3f5: 'تقارير متقدمة: أرباح، موردين، حركة مخزون، ومقارنة بين الفروع',
    p3f6: 'نسخة احتياطية تلقائية ودعم فني بأولوية',
    p3Cta: 'اطلب باقة الاحترافية',

    packagesReassure: 'مش متأكد أنهي باقة تناسبك؟ احجز عرض توضيحي، نشوف محلك مع بعض ونقولك بصراحة إنت محتاج إيه.',

    // --- 4 · screenshots
    shotsTitle: 'شوفه شغّال قبل ما تقرر',
    shotsSub: 'دي شاشات حقيقية من النظام، مش رسومات.',
    capPos: 'شاشة الكاشير — امسح الباركود والفاتورة جاهزة',
    capDashboard: 'أرقام محلك في لمحة',
    capProducts: 'كل صنف بمقاساته وكمياته',
    capShopHome: 'موقعك باسمك وألوانك',
    capShopCheckout: 'الدفع عند الاستلام، زي ما عميلك متعوّد',
    capWebOrders: 'الطلب من الموقع بيوصلك في نفس النظام',
    capAdmin: 'كل محلاتك في شاشة واحدة',

    // Alt text describes what is ON the screen, for someone who cannot see it.
    // Not the caption again — the caption is the sales line and it is already
    // read out beside the picture.
    altPos: 'شاشة نقطة البيع في النظام: خانة الباركود فوق، وسلة فيها أربع قطع بأسعارها، والإجمالي ٥٬٤٤٩٫٢٠ جنيه، وزر إتمام البيع تحته.',
    altDashboard: 'لوحة التحكم: مربعات بمبيعات اليوم وإيرادات الشهر وقيمة المخزون، ورسم بياني لمبيعات آخر ٣٠ يومًا، وتنبيه بأصناف قربت تخلص.',
    altProducts: 'شاشة المنتجات: جدول فيه كود كل صنف واسمه وعدد متغيراته وسعره وكميته في المخزن ومورده وحالته.',
    altShopHome: 'الصفحة الرئيسية للمتجر الإلكتروني على موبايل: شريط شحن مجاني فوق، بانر التشكيلة، وأقسام المنتجات تحته.',
    altShopProduct: 'صفحة منتج في المتجر على موبايل: صورة الشنطة، السعر ٢٬٤٥٠ جنيه، اختيار اللون، والكمية، وزر أضف إلى السلة.',
    altShopCheckout: 'صفحة إتمام الطلب على موبايل: الدفع عند الاستلام مختار، ملخص الطلب بالمنتجات، والإجمالي ٥٬٥٦٣٫٢٠ جنيه، وزر أكّد الطلب.',
    altWebOrders: 'شاشة طلبات الأونلاين في النظام: جدول بأرقام الطلبات وأسماء العملاء ومدنهم وإجمالي كل طلب وحالته — جديد، تم القبول، قيد التوصيل، تم التسليم.',
    altAdmin: 'لوحة KJ Admin: جدول بخمس متاجر، كل واحد بخطته وعدد مستخدميه ومنتجاته وحالته وروابط النظام والمتجر بتاعه.',

    // --- 5 · request a demo
    demoTitle: 'جرّب اللوحة بنفسك، من غير أي التزام',
    demoBody: 'احجز نص ساعة معانا. هنفتحلك النظام بمنتجات شبه بتاعتك، ونوريك إزاي المحل والموقع بيشتغلوا مع بعض — وبعدها إنت اللي تقرر.',
    demoName: 'الاسم',
    demoPhone: 'رقم الموبايل',
    demoShopType: 'نوع المحل (ملابس، عطور، إكسسوارات…)',
    demoBranches: 'عدد الفروع',
    demoMessage: 'حابب تسألنا عن إيه؟',
    demoOptional: '(اختياري)',
    demoCta: 'اطلب عرض توضيحي للوحة KJ Admin',
    demoNote: 'بنرد في نفس اليوم. من غير بيانات بنك ولا دفع مقدم.',

    // --- FAQ (the three objections from the copy)
    faq1Q: 'النت بيقطع عندي — هعمل إيه؟',
    faq1A: 'الكاشير بيشتغل على جهاز المحل نفسه، فلو النت راح البيع ما بيقفش.',
    faq2Q: 'موظفيني مش بيعرفوا كمبيوتر.',
    faq2A: 'الشاشة بالعربي وكبيرة، والتدريب داخل الباقة. أغلب الكاشيرات بيتعلموا في يوم.',
    faq3Q: 'بياناتي هتبقى فين؟',
    faq3A: 'بياناتك بتاعتك — نسخة احتياطية تلقائية، وتقدر تطلب نسخة منها في أي وقت.',

    // --- 6 · contact
    contactTitle: 'كلّمنا',
    contactBody: 'لو عندك سؤال قبل ما تحجز، اتصل أو ابعتلنا واتساب — هنرد عليك بنفسنا، مش روبوت.',
    contactPhone: 'تليفون',
    contactWhatsapp: 'واتساب',
    contactEmail: 'البريد الإلكتروني',
    contactHours: 'من السبت للخميس، من ١٠ ص لـ ٨ م',
    contactCall: 'اتصل بينا دلوقتي',
    contactWa: 'كلّمنا على واتساب',

    // --- footer
    footTagline: 'KJ — إدارة محلات وبيع أونلاين',
    footMade: 'صُنع في مصر لأصحاب المحلات في مصر',
    footRights: '© 2026 KJ. كل الحقوق محفوظة.',
  },

  en: {
    pageTitle: 'KJ — Shop management and online store, built in Egypt',
    metaDescription: 'Manage stock and sales and open your own online shop, from one Arabic platform. Packages from 2,000 EGP a month.',

    skipToContent: 'Skip to content',
    langSwitch: 'العربية',
    langSwitchLabel: 'التبديل إلى العربية',
    navLabel: 'Page links',
    footNavLabel: 'Footer links',
    navPackages: 'Packages',
    navDemo: 'Request a Demo',
    navContact: 'Contact',

    heroEyebrow: 'Shop management and online selling — built in Egypt',
    heroTitle: 'Run your whole shop from one screen',
    heroSub: 'Stock, till, invoices, reports and your own online shop — one platform, in Arabic, simple enough that anyone on your team can use it from day one.',
    heroPrimary: 'Request a Demo',
    heroSecondary: 'See packages and pricing',
    trust1: 'Works in-store even when the internet drops',
    trust2: 'Fully Arabic and English',
    trust3: 'Setup and training included, no extra fee',

    overviewTitle: 'Your shop is busy — but nothing is in one place',
    overviewIntro: 'Most shop owners in Egypt keep stock in a notebook, sales on a phone, and online orders in WhatsApp messages. It all works — until you try to answer a simple question: what sold, what is left, and what actually makes money. KJ puts all of it in one place.',
    block1Title: 'Sell and settle in seconds',
    block1Body: 'Open the till, scan the barcode, print the invoice. Stock comes down by itself and the shift closes at the end of the day with numbers you can trust — no paper arithmetic.',
    block2Title: 'Know exactly what you have',
    block2Body: 'Every item with its sizes, colours, price and its own barcode. Print your own barcode labels, run a stock count, and see what is about to run out before a customer asks for it.',
    block3Title: 'Open online, without starting over',
    block3Body: 'One switch and you have an online shop under your own name, your logo, your colours, with cash on delivery. An order from the website lands in the same system — same stock, same invoices, same reports.',
    overviewClose: 'One branch or five, online and in-store — the same numbers, in one place you can actually look at.',

    packagesTitle: 'Clear packages, no surprises',
    packagesSub: 'Every package includes setup, training and updates. No annual contract — change or cancel any time.',

    p1Name: 'Starter',
    p1Price: '2,000 EGP',
    p1Period: '/ month',
    p1Line: 'For a single shop that wants its stock and sales under control',
    p1f1: 'Full point-of-sale screen with barcode scanner support',
    p1f2: 'Inventory: products, sizes and colours, and an alert when a line is running low',
    p1f3: 'Invoices, returns and a daily shift close',
    p1f4: 'Core sales reports: what is selling and what is sitting',
    p1f5: 'Two users (owner + cashier)',
    p1Cta: 'Start with Starter',

    p2Name: 'Growth',
    p2Price: '3,500 EGP',
    p2Period: '/ month',
    p2Badge: 'Most popular',
    p2Line: 'For when you want to sell online without leaving the counter',
    p2f1: 'Everything in Starter, plus:',
    p2f2: 'Your own online shop under your name, with your logo and colours, in Arabic and English',
    p2f3: 'Cash on delivery and shipping you set yourself (a flat amount or a percentage of the order)',
    p2f4: 'Website orders land in the same system and come off the same stock',
    p2f5: 'Print your own barcode labels',
    p2f6: '5 users, each with their own permissions',
    p2Cta: 'Start with Growth',

    p3Name: 'Premium',
    p3Price: '6,000 EGP',
    p3Period: '/ month',
    p3Line: 'For more than one branch, and for seeing every shop on one screen',
    p3f1: 'Everything in Growth, plus:',
    p3f2: 'Multiple branches and shops, each with its own data, logo and website',
    p3f3: 'The KJ Admin dashboard: every shop, its sales and its users, on one screen',
    p3f4: 'Unlimited users, with permissions you set in detail per employee',
    p3f5: 'Advanced reports: profit, suppliers, stock movement, and branch-vs-branch',
    p3f6: 'Automatic backups and priority support',
    p3Cta: 'Get Premium',

    packagesReassure: 'Not sure which package fits? Book a demo — we will look at your shop together and tell you honestly what you need.',

    shotsTitle: 'See it working before you decide',
    shotsSub: 'These are real screens from the system, not illustrations.',
    capPos: 'The till — scan, and the invoice is ready',
    capDashboard: "Your shop's numbers at a glance",
    capProducts: 'Every product, every size, every quantity',
    capShopHome: 'Your website, your name, your colours',
    capShopCheckout: 'Cash on delivery, the way your customer expects',
    capWebOrders: 'A website order arrives inside the same system',
    capAdmin: 'Every shop on one screen',

    altPos: 'The point-of-sale screen: a barcode field at the top, a basket holding four items with their prices, a total of 5,449.20 EGP and a complete-sale button under it.',
    altDashboard: 'The dashboard: tiles for today’s sales, this month’s revenue and stock value, a chart of the last 30 days of sales, and an alert listing items that are running low.',
    altProducts: 'The products screen: a table with each item’s code, name, number of variants, price, stock quantity, supplier and status.',
    altShopHome: 'The online shop’s home page on a phone: a free-delivery strip at the top, the collection banner, and the product categories below it.',
    altShopProduct: 'A product page in the online shop on a phone: the bag’s photo, a price of 2,450 EGP, colour options, a quantity stepper and an add-to-cart button.',
    altShopCheckout: 'The checkout on a phone: cash on delivery selected, an order summary listing the items, a total of 5,563.20 EGP and a confirm-order button.',
    altWebOrders: 'The web-orders screen: a table of order numbers, customer names, cities, order totals and each order’s stage — new, accepted, out for delivery, delivered.',
    altAdmin: 'The KJ Admin dashboard: a table of five shops, each with its plan, its user and product counts, its status and links to its own system and storefront.',

    demoTitle: 'Try the dashboard yourself, with no commitment',
    demoBody: 'Book half an hour with us. We will open the system with products like yours and show you how the shop and the website work together — then you decide.',
    demoName: 'Name',
    demoPhone: 'Mobile number',
    demoShopType: 'Type of shop (clothes, perfume, accessories…)',
    demoBranches: 'Number of branches',
    demoMessage: 'Anything you want to ask?',
    demoOptional: '(optional)',
    demoCta: 'Request a Demo of KJ Admin Dashboard',
    demoNote: 'We reply the same day. No bank details, nothing paid up front.',

    faq1Q: 'My internet cuts out — what then?',
    faq1A: 'The till runs on the shop’s own computer, so a dropped connection does not stop you selling.',
    faq2Q: 'My staff are not computer people.',
    faq2A: 'The screen is in Arabic and it is big, and training is in the package. Most cashiers pick it up in a day.',
    faq3Q: 'Where does my data live?',
    faq3A: 'It is yours — backed up automatically, and you can ask for a copy of it whenever you want.',

    contactTitle: 'Talk to us',
    contactBody: 'If you have a question before booking, call us or send a WhatsApp — you will get a person, not a bot.',
    contactPhone: 'Phone',
    contactWhatsapp: 'WhatsApp',
    contactEmail: 'Email',
    contactHours: 'Saturday to Thursday, 10am – 8pm',
    contactCall: 'Call us now',
    contactWa: 'Message us on WhatsApp',

    footTagline: 'KJ — shop management and online selling',
    footMade: 'Made in Egypt, for shop owners in Egypt',
    footRights: '© 2026 KJ. All rights reserved.',
  },
};

// =========================================================================
// LANGUAGE
// =========================================================================

/**
 * Arabic wins on first visit — this page sells to Egyptian shop owners and it
 * is written for them. `localStorage` is read inside a `try` because private
 * browsing on iOS has historically thrown on access, and a storage quirk must
 * not take a sales page down.
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

const isRtl = () => language === 'ar';

/** `t('key')`. Falls back through English to the key itself rather than blanking. */
function t(key) {
  return dictionary[language]?.[key] ?? dictionary.en[key] ?? key;
}

/**
 * `dir` on `<html>` is the ONLY thing that mirrors this page. `kj.css` has no
 * `left`, no `right` and no `[dir=rtl]` block in it — every edge is written as
 * an inline-start or inline-end — so flipping this attribute is the whole
 * translation of the layout.
 */
function applyDocumentLanguage() {
  const root = document.documentElement;
  root.lang = language;
  root.dir = isRtl() ? 'rtl' : 'ltr';
  document.title = t('pageTitle');
  for (const selector of ['meta[name="description"]', 'meta[property="og:description"]']) {
    document.querySelector(selector)?.setAttribute('content', t('metaDescription'));
  }
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', t('pageTitle'));
  document.querySelector('meta[property="og:locale"]')
    ?.setAttribute('content', isRtl() ? 'ar_EG' : 'en_US');
}

/**
 * Paint every translated string in the document.
 *
 * Four attributes, because a page has four kinds of string in it: the words
 * you read, the alt text you hear instead of a picture, the label a control
 * announces itself with, and the ghost text in an empty field.
 */
function paint() {
  const set = (attr, apply) => {
    for (const node of document.querySelectorAll(`[${attr}]`)) {
      apply(node, t(node.getAttribute(attr)));
    }
  };
  set('data-i18n', (node, value) => { node.textContent = value; });
  set('data-i18n-alt', (node, value) => { node.setAttribute('alt', value); });
  set('data-i18n-label', (node, value) => { node.setAttribute('aria-label', value); });
  set('data-i18n-placeholder', (node, value) => { node.setAttribute('placeholder', value); });
  paintShots();
}

/**
 * The screenshots come in `-ar` / `-en` pairs and every pair is identical in
 * dimensions, so this swap cannot move anything on the page. The `width` and
 * `height` attributes stay as they are in the HTML for the same reason.
 */
function paintShots() {
  for (const img of document.querySelectorAll('[data-shot]')) {
    img.src = `/kj/shots/${img.dataset.shot}-${language}.webp`;
  }
}

function setLanguage(next) {
  const value = next === 'en' ? 'en' : 'ar';
  if (value === language) return;
  language = value;
  try { window.localStorage.setItem(STORAGE_KEY, value); } catch { /* storage is a nicety */ }
  applyDocumentLanguage();
  paint();
}

function wireLanguageToggle() {
  const button = document.querySelector('[data-lang-toggle]');
  if (!button) return;
  button.hidden = false;
  button.addEventListener('click', () => setLanguage(isRtl() ? 'en' : 'ar'));
}

// =========================================================================
// THE FORM
// =========================================================================

/**
 * There is no backend behind this page and none is invented here.
 *
 * The form is a WhatsApp composer: it takes what the visitor typed, writes it
 * into a message addressed to the number on the page, and opens WhatsApp with
 * that message already in the box. Nothing is posted anywhere, no third-party
 * form service is called, and the visitor sends the message themselves — which
 * is also why the lead actually arrives instead of landing in an inbox nobody
 * owns.
 *
 * With this file gone the `<form>` still works: it is a plain GET to
 * `https://wa.me/201552526142` and none of its fields carry a `name`, so an
 * unenhanced submit opens the same WhatsApp conversation — just empty. A form
 * that silently does nothing would be worse than no form; this one degrades to
 * the WhatsApp button underneath it.
 */
function wireDemoForm() {
  const form = document.querySelector('[data-demo-form]');
  if (!form) return;

  form.addEventListener('submit', (event) => {
    const value = (id) => document.getElementById(id)?.value.trim() || '';
    // Every line below is built out of strings that are already on the page:
    // the button's own label, then each field's own label followed by what was
    // typed into it. An empty field contributes no line at all.
    const lines = [t('demoCta'), ''];
    for (const [id, key] of [
      ['demo-name', 'demoName'],
      ['demo-phone', 'demoPhone'],
      ['demo-shop-type', 'demoShopType'],
      ['demo-branches', 'demoBranches'],
      ['demo-message', 'demoMessage'],
    ]) {
      const typed = value(id);
      if (typed) lines.push(`${t(key)}: ${typed}`);
    }
    // Nothing typed at all — let the plain GET through and open the chat.
    if (lines.length === 2) return;
    event.preventDefault();
    window.open(
      `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(lines.join('\n'))}`,
      '_blank',
      'noopener',
    );
  });
}

// =========================================================================
// REVEAL
// =========================================================================

/**
 * A section fading up as it arrives — and nothing else. It exists only when
 * this file runs (the attribute below is what arms the CSS), it is entirely
 * inside `prefers-reduced-motion: no-preference` in the sheet, and it never
 * hides anything permanently: an element that is not observed, or a browser
 * with no `IntersectionObserver`, keeps the page exactly as it is.
 */
function wireReveal() {
  const targets = document.querySelectorAll('[data-reveal]');
  if (!targets.length || !('IntersectionObserver' in window)) return;
  document.documentElement.dataset.reveal = 'armed';
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.dataset.reveal = 'in';
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.05 });
  for (const target of targets) observer.observe(target);
}

// =========================================================================
// BOOT
// =========================================================================

/**
 * The palette, from the one hex — the same function the storefront paints a
 * shop's colour with and the ERP previews it with, so KJ's own page cannot
 * derive its indigo differently from the product it is selling.
 */
applyTheme(document.documentElement, { accent: ACCENT, dark: true });
document.querySelector('link[rel="icon"]')
  ?.setAttribute('href', monogramFavicon('KJ', { accent: ACCENT, dark: true }));

applyDocumentLanguage();
paint();
wireLanguageToggle();
wireDemoForm();
wireReveal();
