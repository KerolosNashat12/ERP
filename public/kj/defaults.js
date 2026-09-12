/**
 * The words the KJEVORA landing page ships with.
 *
 * This is the whole page as a document: every string in both languages, every
 * system and its bullets, every FAQ entry, every caption. `kj.js` renders it,
 * and the HTML next door is this same content already written out — so a
 * visitor whose JavaScript never runs reads the same page.
 *
 * It is a module of its own, and that is the point. THREE readers need this
 * object and none of them may hold a second copy of it:
 *
 *   - `kj.js`, which renders it and then merges the owner's stored document
 *     over it;
 *   - the landing editor in the console (`public/platform/js/views/landing.js`),
 *     which shows an unedited field with the text a visitor is actually
 *     reading, and which could not offer "restore the original" without
 *     knowing what the original said;
 *   - a reader deciding what a section is for.
 *
 * The editor used to lift this literal out of `kj.js` by brace-matching its
 * source text, because `kj.js` exports nothing and importing it runs the whole
 * landing page's boot sequence — which would have repainted the console's own
 * theme out from under it. That bridge worked and would have broken on the
 * first refactor of that file. This file is the one line that retired it.
 *
 * Nothing here is markup. Nothing here names the console: it is the owner's,
 * not a thing a customer can buy, and mentioning it only invites a question
 * whose answer is no.
 *
 * NO PACKAGE CARRIES A PRICE. `packages` is the three SYSTEMS now, and three
 * systems sold to three different kinds of business do not share one number,
 * so every card ends in a quote request instead. `price` is left off each
 * item rather than set to zero — the page hides the price line when there is
 * no price, and would show it again the moment one is entered in the console.
 */

export const DEFAULTS = {
  version: 1,

  brand: {
    // A company name is not translated; both halves are the same on purpose.
    name: { ar: 'KJEVORA', en: 'KJEVORA' },
    tagline: {
      ar: 'KJEVORA SOFTWARE SOLUTIONS — أنظمة إدارة وبرمجيات للشركات في مصر',
      en: 'KJEVORA SOFTWARE SOLUTIONS — business systems and software, built in Egypt',
    },
    /** ONE hex, taken from the cyan in the company mark. Every shade the sheet
        paints with is derived from it. */
    accent: '#1b8fd0',
    logo: null,
  },

  contact: {
    phone: '01121249801',
    whatsapp: '01121249801',
    email: 'kerolosnashatestfanous@gmail.com',
    hours: {
      ar: 'من السبت للخميس، من ١٠ ص لـ ٨ م — الجيزة، مصر',
      en: 'Saturday to Thursday, 10am – 8pm — Giza, Egypt',
    },
  },

  seo: {
    title: {
      ar: 'KJEVORA SOFTWARE SOLUTIONS — أنظمة إدارة وبرمجيات للشركات في مصر',
      en: 'KJEVORA SOFTWARE SOLUTIONS — business systems and software, built in Egypt',
    },
    description: {
      ar: 'KJEVORA SOFTWARE SOLUTIONS — بنبني أنظمة إدارة كاملة للشركات في مصر وبنركّبها وندرّب فريقك: نظام محلات وموقع بيع أونلاين، نظام تصنيع وتكاليف، ونظام لشركات التشطيب.',
      en: 'KJEVORA SOFTWARE SOLUTIONS builds complete business systems in Egypt, installs them and trains your team: a retail system with its own online shop, a manufacturing and costing system, and a system for fit-out contractors.',
    },
  },

  // --- 1 · hero ----------------------------------------------------------
  hero: {
    eyebrow: {
      ar: 'أنظمة إدارة وبرمجيات للشركات',
      en: 'Business systems and software',
    },
    title: {
      ar: 'بنبني الأنظمة اللي بتشغّل شركتك',
      en: 'We build the systems that run your business',
    },
    subtitle: {
      ar: 'مش بنبيع برنامج وننصرف. بنفهم شغلك، نبني عليه نظام كامل، نركّبه، ندرّب فريقك، ونفضل معاك بعد ما يشتغل.',
      en: 'We do not sell you software and disappear. We learn how you work, build the system around it, install it, train your team, and stay once it is running.',
    },
    primaryCta: { ar: 'اطلب عرض سعر', en: 'Request a quote' },
    secondaryCta: { ar: 'شوف أنظمتنا', en: 'See our systems' },
    trust: [
      { ar: 'تلات أنظمة شغالة عند عملاء حقيقيين', en: 'Three systems, live with real clients' },
      { ar: 'عربي وإنجليزي بالكامل', en: 'Fully Arabic and English' },
      { ar: 'تركيب وتدريب ودعم من غير رسوم إضافية', en: 'Setup, training and support included, no extra fee' },
    ],
    image: null,
  },

  // --- 2 · the three systems ---------------------------------------------
  // The slot is still called `packages`: the console edits it, the page's
  // cards carry the same classes, and a card can still grow a price. What
  // changed is what a card MEANS — one of three products, not one of three
  // price tiers of the same one.
  packages: {
    kicker: { ar: 'أنظمتنا', en: 'Our systems' },
    title: {
      ar: 'تلات أنظمة، كل واحد اتبنى لشغل مختلف',
      en: 'Three systems, each built for a different kind of business',
    },
    note: {
      ar: 'مش قوالب. كل نظام من التلاتة شغّال دلوقتي عند عميل، وبيتظبط على طريقة شغلك قبل ما يبدأ عندك.',
      en: 'Not templates. Each of the three is live with a client today, and it is fitted to the way you work before it starts.',
    },
    reassure: {
      ar: 'مش متأكد أنهي نظام يناسبك؟ اطلب مكالمة، نشوف شغلك مع بعض ونقولك بصراحة إنت محتاج إيه.',
      en: 'Not sure which one fits? Ask for a call — we will look at your business together and tell you honestly what you need.',
    },
    currency: { ar: 'جنيه', en: 'EGP' },
    period: { ar: '/ شهريًا', en: '/ month' },
    items: [
      {
        id: 'retail',
        name: { ar: 'نظام المحلات + موقع بيع أونلاين', en: 'Retail system + online shop' },
        badge: { ar: 'لمحلات التجزئة', en: 'For retail shops' },
        featured: false,
        oneLiner: {
          ar: 'كاشير ومخزن وفواتير وتقارير، وموقع بيع باسم محلك — والطلب من الموقع بيتخصم من نفس المخزون.',
          en: 'Till, stock, invoices and reports, plus an online shop in your own name — and an order from it comes off the same stock.',
        },
        inherits: null,
        features: [
          { ar: 'كاشير كامل مع قارئ الباركود، وبيشتغل في المحل حتى لو النت قطع',
            en: 'A full till with barcode scanning that keeps selling when the connection drops' },
          { ar: 'مخزون بمقاسات وألوان ومتغيرات، وتنبيه قبل ما الصنف يخلص',
            en: 'Stock with sizes, colours and variants, and a warning before a line runs out' },
          { ar: 'فواتير ومرتجعات وتبديلات وموردين وتقفيل وردية بأرقام صح',
            en: 'Invoices, returns, exchanges, suppliers, and an end-of-day close that adds up' },
          { ar: 'تقارير أرباح ومبيعات ومخزون، وفروع متعددة لما الشغل يكبر',
            en: 'Profit, sales and stock reports — and multiple branches when the business grows' },
        ],
        cta: { ar: 'اطلب عرض سعر', en: 'Request a quote' },
      },
      {
        id: 'chemcost',
        name: { ar: 'ChemCost — نظام التصنيع والتكاليف', en: 'ChemCost — manufacturing and costing' },
        badge: { ar: 'لتركيب العطور ومستحضرات التجميل', en: 'For perfume and cosmetics compounding' },
        featured: false,
        oneLiner: {
          ar: 'لو بتصنّع اللي بتبيعه: بيحسبلك تكلفة كل منتج من مكوناته بالمليم، قبل ما تحط سعر البيع.',
          en: 'If you make what you sell: it costs every product out of its own ingredients, to the piastre, before you set a price.',
        },
        inherits: null,
        features: [
          { ar: 'تركيبة لكل منتج، والتكلفة بتتحسب لوحدها وبتتحدّث مع كل شراء',
            en: 'A recipe per product; the cost computes itself and moves with every purchase' },
          { ar: 'خامات بتشغيلات، لكل تشغيلة كميتها المتبقية وتاريخ صلاحيتها',
            en: 'Raw materials in batches, each with its remaining quantity and expiry date' },
          { ar: 'أوامر إنتاج، وجرد وهدر، وتقارير تكاليف وأرباح لكل منتج',
            en: 'Production orders, stock counts and wastage, and cost and profit per product' },
        ],
        cta: { ar: 'اطلب عرض سعر', en: 'Request a quote' },
      },
      {
        id: 'highlevel',
        name: { ar: 'High Level — موقع ولوحة تحكم', en: 'High Level — website and dashboard' },
        badge: { ar: 'لشركات التشطيب والديكور', en: 'For fit-out and interiors' },
        featured: false,
        oneLiner: {
          ar: 'موقع بيجيب لك عملاء، ولوحة تحكم بتمسك الباقات والأسعار والطلبات من وراه.',
          en: 'A website that brings you clients, and a dashboard behind it holding your packages, prices and enquiries.',
        },
        inherits: null,
        features: [
          { ar: 'موقع شركة كامل بباقاتك وخدماتك وأعمالك، عربي وإنجليزي',
            en: 'A complete company website with your packages, services and portfolio, in Arabic and English' },
          { ar: 'محرك تقسيط: العميل يحسب تكلفته وقسطه بنفسه قبل ما يكلّمك',
            en: 'A financing calculator: a client works out their own cost and instalment before they call' },
          { ar: 'تغيّر الباقات والأسعار والمحتوى من غير ما تستنى مبرمج',
            en: 'Change packages, prices and content without waiting on a developer' },
        ],
        cta: { ar: 'اطلب عرض سعر', en: 'Request a quote' },
      },
    ],
  },

  // --- 3 · in every system ------------------------------------------------
  included: {
    enabled: true,
    title: { ar: 'في كل نظام، من غير فلوس زيادة', en: 'In every system, at no extra cost' },
    items: [
      { ar: 'التركيب والتجهيز', en: 'Setup and installation' },
      { ar: 'نقل بياناتك القديمة', en: 'Moving your existing data' },
      { ar: 'تدريب فريقك', en: 'Training for your team' },
      { ar: 'التحديثات أول بأول', en: 'Updates as they come' },
      { ar: 'دعم بالعربي، من بني آدم', en: 'Support in Arabic, from a person' },
      { ar: 'بياناتك بتاعتك، وتقدر تاخد نسخة منها', en: 'Your data is yours, and you can take a copy of it' },
    ],
  },

  // --- 4 · why Nexora -----------------------------------------------------
  overview: {
    kicker: { ar: 'نظام مخصص', en: 'Custom builds' },
    title: { ar: 'شغلك مختلف؟ بنبنيه من الأول', en: 'Business not like the others? We build it from scratch' },
    intro: {
      ar: 'التلات أنظمة فوق كلهم بدأوا كده — شركة محتاجة حاجة مش موجودة في السوق. لو شغلك مش شبه أي واحد فيهم، ده بالظبط اللي بنعمله.',
      en: 'All three systems above started exactly that way — a company needing something the market did not have. If your work is not like any of them, this is precisely what we do.',
    },
    blocks: [
      {
        icon: 'till',
        title: { ar: 'تحليل قبل أي كود', en: 'Analysis before any code' },
        body: {
          ar: 'بنقعد معاك ونطلع بتوصيف مكتوب لكل شاشة وكل حالة قبل ما نكتب سطر واحد.',
          en: 'We sit with you and produce a written spec for every screen and every case before a single line is written.',
        },
      },
      {
        icon: 'boxes',
        title: { ar: 'بناء على مراحل', en: 'Built in stages' },
        body: {
          ar: 'بتشوف النظام شغال أول بأول، مش في الآخر. تعدّل وإحنا بنبني، مش بعد ما نخلص.',
          en: 'You see it working as it grows, not at the end. You change your mind while we build, not after.',
        },
      },
      {
        icon: 'globe-bag',
        title: { ar: 'النظام بتاعك', en: 'The system is yours' },
        body: {
          ar: 'الكود والبيانات بتاعتك وبنسلّمهم. ومفيش حاجة بتقف لو بطّلنا نشتغل مع بعض.',
          en: 'The code and the data are yours and we hand them over. Nothing stops if we stop working together.',
        },
      },
    ],
    closing: {
      ar: 'شغلنا كله بالعربي ومتظبط للسوق المصري — من طريقة الفوترة، للدفع عند الاستلام، لأسماء الحاجات زي ما بتتقال في الشغل فعلًا.',
      en: 'All of it in Arabic and fitted to the Egyptian market — how invoices work, cash on delivery, and things called what people actually call them.',
    },
  },

  // --- 5 · screenshots ----------------------------------------------------
  shots: {
    kicker: { ar: 'من جوه الأنظمة', en: 'Inside the systems' },
    title: { ar: 'شوفها شغّالة قبل ما تقرر', en: 'See them working before you decide' },
    note: {
      ar: 'دي شاشات حقيقية من أنظمة شغالة عند عملائنا دلوقتي، مش رسومات.',
      en: 'Real screens from systems running with our clients today, not illustrations.',
    },
    items: [
      {
        key: 'pos',
        kind: 'desktop',
        caption: { ar: 'نظام المحلات — امسح الباركود والفاتورة جاهزة', en: 'The retail system — scan, and the invoice is ready' },
        enabled: true,
        custom: null,
      },
      {
        key: 'dashboard',
        kind: 'desktop',
        caption: { ar: 'أرقام شغلك في لمحة', en: 'Your numbers at a glance' },
        enabled: true,
        custom: null,
      },
      {
        key: 'highlevel-home',
        kind: 'desktop',
        caption: { ar: 'High Level — موقع الشركة اللي بيجيب العملاء', en: 'High Level — the company website that brings the clients' },
        enabled: true,
        custom: null,
      },
      {
        key: 'highlevel-calc',
        kind: 'desktop',
        caption: { ar: 'العميل بيحسب قسطه بنفسه قبل ما يكلّمك', en: 'A client works out their own instalment before calling you' },
        enabled: true,
        custom: null,
      },
      {
        key: 'shop-home',
        kind: 'phone',
        caption: { ar: 'موقع محلك باسمك وألوانك', en: 'Your shop’s website, your name, your colours' },
        enabled: true,
        custom: null,
      },
      {
        key: 'shop-product',
        kind: 'phone',
        caption: { ar: 'صفحة المنتج زي ما عميلك هيشوفها', en: 'The product page, exactly as your customer sees it' },
        enabled: true,
        custom: null,
      },
      {
        key: 'shop-checkout',
        kind: 'phone',
        caption: { ar: 'الدفع عند الاستلام، زي ما عميلك متعوّد', en: 'Cash on delivery, the way your customer expects' },
        enabled: true,
        custom: null,
      },
    ],
  },

  // --- 6 · clients --------------------------------------------------------
  // REAL NAMES ONLY, and exactly as many as there are. A client row holds the
  // business, what it does, and which of the three systems it runs — three
  // facts a visitor could check. No borrowed logos, no "and 200 others".
  clients: {
    enabled: true,
    kicker: { ar: 'عملاؤنا', en: 'Clients' },
    title: { ar: 'شركات بتشتغل بأنظمتنا', en: 'Businesses running on our systems' },
    note: {
      ar: 'مش أسماء على صفحة — دي أنظمة بتشتغل كل يوم في شغل حقيقي.',
      en: 'Not names on a page — these are systems working every day in real businesses.',
    },
    items: [
      {
        name: 'M&M Accessories',
        line: { ar: 'محل إكسسوارات وعطور', en: 'Accessories and perfume shop' },
        system: { ar: 'نظام المحلات + موقع بيع أونلاين', en: 'Retail system + online shop' },
      },
      {
        name: 'Lustre',
        line: { ar: 'تركيب عطور ومستحضرات تجميل', en: 'Perfume and cosmetics compounding' },
        system: { ar: 'ChemCost', en: 'ChemCost' },
      },
      {
        name: 'OnlyOnce',
        line: { ar: 'تركيب عطور ومستحضرات تجميل', en: 'Perfume and cosmetics compounding' },
        system: { ar: 'ChemCost', en: 'ChemCost' },
      },
      {
        name: 'High Level',
        line: { ar: 'شركة تشطيبات وديكور', en: 'Fit-out and interiors company' },
        system: { ar: 'High Level', en: 'High Level' },
      },
    ],
  },

  // --- 7 · how it works ---------------------------------------------------
  steps: {
    enabled: true,
    kicker: { ar: 'إزاي بنشتغل', en: 'How we work' },
    title: { ar: 'من أول مكالمة لحد ما النظام يشتغل', en: 'From the first call to a system that runs' },
    note: { ar: 'مفيش حاجة فيهم إنت اللي هتعملها لوحدك.', en: 'Not one of them is a thing you do on your own.' },
    items: [
      {
        title: { ar: 'نتكلم ونفهم شغلك', en: 'We talk, and we learn the business' },
        body: {
          ar: 'مكالمة قصيرة نفهم منها بتشتغل إزاي دلوقتي، وإيه اللي واجعك بالظبط، وأنهي نظام هو اللي يفيدك.',
          en: 'A short call: how you work today, what actually hurts, and which system is the one that helps.',
        },
      },
      {
        title: { ar: 'بنظبّط النظام وننقل بياناتك', en: 'We fit it and move your data' },
        body: {
          ar: 'بنجهّزه على شغلك وندخّل أصنافك وأسعارك وبياناتك القديمة. مش هتقعد تكتبهم من أول وجديد.',
          en: 'We set it up around your business and load your products, prices and existing records. You do not retype them.',
        },
      },
      {
        title: { ar: 'بندرّب فريقك', en: 'We train your team' },
        body: {
          ar: 'ساعة أو اتنين مع اللي هيشتغلوا عليه فعلًا. الشاشة بالعربي، وأغلب الناس بتتعلم في يوم.',
          en: 'An hour or two with the people who will actually use it. The screen is in Arabic, and most people have it in a day.',
        },
      },
      {
        title: { ar: 'تشتغل، وإحنا معاك', en: 'You start, and we stay with you' },
        body: {
          ar: 'تبدأ من أول يوم. أي سؤال أو تعديل بعد كده، اتصل أو ابعت واتساب — بنرد بنفسنا.',
          en: 'You are working from day one. Any question or change after that — call or WhatsApp, and you get us.',
        },
      },
    ],
  },



  // --- 10 · what clients say ----------------------------------------------
  // SHIPS EMPTY, and therefore invisible. No client has given one of these for
  // publication yet, and an invented testimonial on a page selling trust is
  // the fastest way to lose it — in a market this small the reader may know
  // the business being quoted. The heading is written and waiting; the
  // section appears the day a real quote is entered.
  quotes: {
    enabled: true,
    title: { ar: 'عملاؤنا بيقولوا إيه', en: 'What our clients say' },
    items: [],
  },

  // --- 11 · request a quote -----------------------------------------------
  demo: {
    kicker: { ar: 'كلّمنا', en: 'Contact' },
    title: { ar: 'ابدأ بمكالمة', en: 'Start with a call' },
    body: {
      ar: 'هنفهم شغلك، ونوريك النظام المناسب شغّال على بيانات شبه بتاعتك، ونبعتلك عرض سعر مكتوب في نفس اليوم — وبعدها إنت اللي تقرر.',
      en: 'We will learn the business, show you the right system running on data like yours, and send you a written quote the same day — then you decide.',
    },
    button: { ar: 'ابعت على واتساب', en: 'Send on WhatsApp' },
    small: {
      ar: 'بنرد في نفس اليوم. من غير بيانات بنك ولا دفع مقدم.',
      en: 'We reply the same day. No bank details, nothing paid up front.',
    },
    fields: {
      name: { ar: 'الاسم', en: 'Name' },
      phone: { ar: 'رقم الموبايل', en: 'Mobile number' },
      shopType: { ar: 'النظام اللي يهمك', en: 'Which system interests you' },
      branches: { ar: 'نوع نشاطك', en: 'What your business does' },
      message: { ar: 'حابب تسألنا عن إيه؟', en: 'Anything you want to ask?' },
    },
  },

  // --- 12 · FAQ -----------------------------------------------------------
  faq: {
    enabled: true,
    kicker: { ar: 'أسئلة', en: 'Questions' },
    title: { ar: 'أسئلة بتتسأل كتير', en: 'Questions we get a lot' },
    items: [
      {
        q: { ar: 'بتشتغلوا مع أنهي أنواع شغل؟', en: 'What kinds of business do you work with?' },
        a: {
          ar: 'محلات التجزئة، وتصنيع وتركيب العطور ومستحضرات التجميل، وشركات التشطيب. دي التلات أنظمة اللي شغالة دلوقتي عند عملاء، ولو شغلك قريب منهم كلّمنا ونشوف.',
          en: 'Retail shops, perfume and cosmetics manufacturing, and fit-out contractors. Those are the three systems live with clients today — if your business is close to one of them, call us and we will look.',
        },
      },
      {
        q: { ar: 'النظام جاهز ولا هيتعمل من الأول؟', en: 'Is the system ready, or built from scratch?' },
        a: {
          ar: 'التلاتة شغالين فعلًا عند عملاء. اللي بيحصل إننا بنظبّط النظام على شغلك — يعني لا بنبني من الصفر وناخد شهور، ولا بنديك قالب من غير تظبيط.',
          en: 'All three are already running with clients. What happens is that we fit one to your business — so neither months of building from nothing, nor a template handed over untouched.',
        },
      },
      {
        q: { ar: 'بكام؟', en: 'How much is it?' },
        a: {
          ar: 'على قد الشغل — النظام اللي محتاجه، وحجم بياناتك، وعدد اللي هيشتغلوا عليه. اطلب عرض سعر وهنبعتلك رقم مكتوب في نفس اليوم، من غير مفاجآت بعد كده.',
          en: 'It depends on the work — which system you need, how much data you have, and how many people will use it. Ask for a quote and you will have a written number the same day, with nothing added later.',
        },
      },
      {
        q: { ar: 'النت بيقطع عندي — هعمل إيه؟', en: 'My internet cuts out — what then?' },
        a: {
          ar: 'نظام المحلات بيشتغل على جهاز المحل نفسه، فلو النت راح البيع ما بيقفش.',
          en: 'The retail system runs on the shop’s own computer, so a dropped connection does not stop you selling.',
        },
      },
      {
        q: { ar: 'فريقي مش بيعرف كمبيوتر.', en: 'My team are not computer people.' },
        a: {
          ar: 'الشاشة بالعربي وكبيرة، والتدريب داخل السعر. أغلب الناس بتتعلم في يوم.',
          en: 'The screen is in Arabic and it is big, and training is in the price. Most people pick it up in a day.',
        },
      },
      {
        q: { ar: 'بياناتي هتبقى فين؟', en: 'Where does my data live?' },
        a: {
          ar: 'بياناتك بتاعتك — نسخة احتياطية تلقائية، وتقدر تطلب نسخة منها في أي وقت.',
          en: 'It is yours — backed up automatically, and you can ask for a copy of it whenever you want.',
        },
      },
      {
        q: { ar: 'عندي بيانات قديمة كتير، هدخّلها إزاي؟', en: 'I have a lot of existing data — how does it get in?' },
        a: {
          ar: 'إحنا بندخّلها. ابعتلنا اللي عندك بأي شكل — إكسل، صور، حتى كشكول — وإحنا بنجهّزه.',
          en: 'We put it in. Send us whatever you have — a spreadsheet, photos, even a notebook — and we prepare it.',
        },
      },
    ],
  },

  // --- 13 · the last ask --------------------------------------------------
  closing: {
    enabled: true,
    title: { ar: 'شغلك يستاهل يبقى مرتب', en: 'Your business deserves to be in order' },
    body: {
      ar: 'ابدأ بمكالمة. لو النظام مش هيفيدك هنقولك.',
      en: 'Start with a phone call. If it will not help you, we will tell you.',
    },
    primaryCta: { ar: 'اطلب عرض سعر', en: 'Request a quote' },
    secondaryCta: { ar: 'كلّمنا على واتساب', en: 'Message us on WhatsApp' },
  },

  footer: {
    line: { ar: 'KJEVORA SOFTWARE SOLUTIONS', en: 'KJEVORA SOFTWARE SOLUTIONS' },
    madeIn: { ar: 'Driving Innovation Forward', en: 'Driving Innovation Forward' },
    rights: {
      ar: '© 2026 KJEVORA SOFTWARE SOLUTIONS. كل الحقوق محفوظة.',
      en: '© 2026 KJEVORA SOFTWARE SOLUTIONS. All rights reserved.',
    },
  },
};
