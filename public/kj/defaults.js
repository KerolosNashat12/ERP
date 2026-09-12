/**
 * The words the Nexora landing page ships with.
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
    name: { ar: 'Nexora', en: 'Nexora' },
    tagline: {
      ar: 'نكسورا — أنظمة إدارة وبرمجيات للشركات في مصر',
      en: 'Nexora — business systems and software, built in Egypt',
    },
    /** ONE hex, taken from the blue in the company mark. Every shade the
        sheet paints with is derived from it. */
    accent: '#0a5f96',
    logo: null,
  },

  contact: {
    phone: '01552526142',
    whatsapp: '01552526142',
    email: 'kerolosnashatestfanous@gmail.com',
    hours: {
      ar: 'من السبت للخميس، من ١٠ ص لـ ٨ م',
      en: 'Saturday to Thursday, 10am – 8pm',
    },
  },

  seo: {
    title: {
      ar: 'نكسورا — أنظمة إدارة وبرمجيات للشركات في مصر',
      en: 'Nexora — business systems and software, built in Egypt',
    },
    description: {
      ar: 'نكسورا بتبني وبتشغّل أنظمة إدارة كاملة للشركات في مصر: نظام محلات وموقع بيع أونلاين، ونظام تصنيع وتكاليف، ونظام لشركات التشطيب — عربي بالكامل، بتركيب وتدريب ودعم.',
      en: 'Nexora builds and runs complete business systems in Egypt: a retail system with its own online shop, a manufacturing and costing system, and a system for fit-out contractors — fully Arabic, with setup, training and support.',
    },
  },

  // --- 1 · hero ----------------------------------------------------------
  hero: {
    eyebrow: {
      ar: 'نكسورا — حلول برمجية مصرية',
      en: 'Nexora — software built in Egypt',
    },
    title: {
      ar: 'أنظمة بتمسك شغلك كله، مش بس بتسجّله',
      en: 'Systems that run your business, not just record it',
    },
    subtitle: {
      ar: 'بنبني وبنشغّل أنظمة إدارة كاملة للشركات في مصر — من المحل والمخزن، للتصنيع والتكاليف، لشركات التشطيب. عربي بالكامل، وبنركّبها وندرّب فريقك وبنفضل معاك بعدها.',
      en: 'We build and run complete business systems in Egypt — from the shop floor and the stockroom to manufacturing costs and contracting. Fully Arabic, installed by us, taught to your team, and supported afterwards.',
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
    title: {
      ar: 'تلات أنظمة، كل واحد اتبنى لشغل مختلف',
      en: 'Three systems, each built for a different kind of business',
    },
    note: {
      ar: 'مش قالب واحد بنبيعه لكل الناس. كل نظام من التلاتة شغّال دلوقتي عند عميل حقيقي، وبيتظبط على طريقة شغلك قبل ما يبدأ.',
      en: 'Not one template sold to everybody. Each of the three is live with a real client today, and it is fitted to the way you work before it starts.',
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
        name: {
          ar: 'نظام المحلات + موقع بيع أونلاين',
          en: 'Retail system + online shop',
        },
        badge: { ar: 'لمحلات التجزئة', en: 'For retail shops' },
        featured: false,
        oneLiner: {
          ar: 'لمحلات الملابس والإكسسوارات والعطور والهدايا — كاشير ومخزن وفواتير وتقارير، وموقع بيع باسم محلك.',
          en: 'For clothing, accessories, perfume and gift shops — till, stock, invoices and reports, plus an online shop under your own name.',
        },
        inherits: null,
        features: [
          {
            ar: 'شاشة كاشير كاملة مع قارئ الباركود، وبتشتغل في المحل حتى لو النت قطع',
            en: 'A full till with barcode-scanner support that keeps selling even when the connection drops',
          },
          {
            ar: 'مخزون بمقاسات وألوان ومتغيرات، وتنبيه قبل ما الصنف يخلص',
            en: 'Stock with sizes, colours and variants, and a warning before a line runs out',
          },
          {
            ar: 'موقع بيع أونلاين باسم محلك وبألوانك، والطلب بيدخل على نفس المخزون',
            en: 'An online shop in your name and colours, with orders landing against the same stock',
          },
          {
            ar: 'فواتير ومرتجعات وتبديلات وموردين وتقفيل وردية بأرقام صح',
            en: 'Invoices, returns, exchanges, suppliers, and an end-of-day close that adds up',
          },
          {
            ar: 'تقارير أرباح ومبيعات ومخزون، وفروع متعددة لما الشغل يكبر',
            en: 'Profit, sales and stock reports — and multiple branches when the business grows',
          },
        ],
        cta: { ar: 'اطلب عرض سعر', en: 'Request a quote' },
      },
      {
        id: 'chemcost',
        name: {
          ar: 'ChemCost — نظام التصنيع والتكاليف',
          en: 'ChemCost — manufacturing and costing',
        },
        badge: {
          ar: 'لتركيب العطور ومستحضرات التجميل',
          en: 'For perfume and cosmetics compounding',
        },
        featured: true,
        oneLiner: {
          ar: 'لو بتصنّع منتجاتك بنفسك — بيحسبلك تكلفة كل منتج من مكوناته بالمليم، قبل ما تحط سعر البيع.',
          en: 'If you make what you sell — it costs every product out of its own ingredients, to the piastre, before you set a price.',
        },
        inherits: null,
        features: [
          {
            ar: 'تركيبة لكل منتج بمكوناتها وكمياتها، والتكلفة بتتحسب لوحدها وبتتحدّث مع كل شراء',
            en: 'A recipe per product with its ingredients and quantities; the cost computes itself and moves with every purchase',
          },
          {
            ar: 'مخزون خامات بتشغيلات، لكل تشغيلة كميتها المتبقية وتاريخ صلاحيتها',
            en: 'Raw-material stock in batches, each with its remaining quantity and its expiry date',
          },
          {
            ar: 'أوامر إنتاج بأكتر من منتج، والخامات بتتخصم من المخزن لوحدها',
            en: 'Production orders covering more than one product, with materials drawn down automatically',
          },
          {
            ar: 'جرد وحركة مخزون وهدر، وتقارير تكاليف وأرباح لكل منتج',
            en: 'Stock counts, stock movement and wastage, with cost and profit reports per product',
          },
          {
            ar: 'مقاسات وأحجام وعبوات لنفس المنتج، كل واحدة بتكلفتها وسعرها',
            en: 'Sizes, volumes and pack formats of the same product, each with its own cost and price',
          },
        ],
        cta: { ar: 'اطلب عرض سعر', en: 'Request a quote' },
      },
      {
        id: 'highlevel',
        name: {
          ar: 'High Level — موقع ولوحة تحكم شركات التشطيب',
          en: 'High Level — website and dashboard for fit-out companies',
        },
        badge: { ar: 'لشركات التشطيب والديكور', en: 'For fit-out and interiors' },
        featured: false,
        oneLiner: {
          ar: 'موقع بيجيب لك عملاء، ولوحة تحكم بتمسك الباقات والأسعار والطلبات من وراه.',
          en: 'A website that brings you clients, and a dashboard behind it holding your packages, prices and enquiries.',
        },
        inherits: null,
        features: [
          {
            ar: 'موقع شركة كامل بباقاتك وخدماتك وأعمالك، عربي وإنجليزي',
            en: 'A complete company website with your packages, services and portfolio, in Arabic and English',
          },
          {
            ar: 'محرك تقسيط ذكي: العميل يحسب تكلفة وحدته وقسطه الشهري بنفسه قبل ما يكلّمك',
            en: 'A financing calculator: a client works out the cost of their unit and their monthly instalment before they call you',
          },
          {
            ar: 'طلبات المعاينة والاستفسارات بتوصلك مجمّعة، مش رسايل متفرقة',
            en: 'Site-visit requests and enquiries arrive together, not scattered across messages',
          },
          {
            ar: 'لوحة تحكم بتغيّر منها الباقات والأسعار والمحتوى من غير ما تستنى مبرمج',
            en: 'A dashboard for changing packages, prices and content without waiting on a developer',
          },
          {
            ar: 'صفحات خدمات ومدونة متظبطة لجوجل، عشان الناس توصلك من البحث',
            en: 'Service pages and a blog built for search, so people find you through Google',
          },
        ],
        cta: { ar: 'اطلب عرض سعر', en: 'Request a quote' },
      },
    ],
  },

  // --- 3 · in every system ------------------------------------------------
  included: {
    enabled: true,
    title: {
      ar: 'في كل نظام من نكسورا، من غير فلوس زيادة',
      en: 'In every Nexora system, at no extra cost',
    },
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
    title: { ar: 'ليه نكسورا؟', en: 'Why Nexora?' },
    intro: {
      ar: 'في السوق أنظمة كتير جاهزة، بس أغلبها مكتوب لشغل مش شغلك: مصطلحات مش بتاعتك، وشاشات فيها حاجات عمرك ما هتفتحها، وحاجات إنت محتاجها مش موجودة أصلًا. إحنا بنشتغل بالعكس — بنفهم شغلك الأول، وبنظبّط النظام عليه، وبنفضل معاك بعد ما يشتغل.',
      en: 'There is no shortage of off-the-shelf systems, and most of them were written for somebody else’s business: words you do not use, screens you will never open, and the one thing you actually need missing. We work the other way round — understand the business first, fit the system to it, and stay once it is running.',
    },
    blocks: [
      {
        icon: 'till',
        title: { ar: 'نظام على مقاس شغلك', en: 'Fitted to your business' },
        body: {
          ar: 'كل نظام من التلاتة اتبنى مع عميل حقيقي وهو شغال، مش في مكتب. ولما ييجي لك، بيتظبط على أصنافك وأسعارك وطريقة شغلك إنت قبل ما تشوفه.',
          en: 'Each of the three was built alongside a real business while it was trading, not in an office. When it reaches you it is fitted to your products, your prices and your way of working before you ever see it.',
        },
      },
      {
        icon: 'boxes',
        title: { ar: 'كل حاجة مربوطة ببعضها', en: 'One system, not five files' },
        body: {
          ar: 'المخزن والبيع والتكاليف والتقارير جوه نظام واحد. الرقم اللي بتشوفه في التقرير جاي من نفس الحركة اللي حصلت على الأرض، مش من ملف تاني حد بيملاه بالإيد.',
          en: 'Stock, selling, costs and reports live in one system. The number in the report comes from the movement that actually happened, not from a second file somebody fills in by hand.',
        },
      },
      {
        icon: 'globe-bag',
        title: { ar: 'بنفضل معاك بعد التسليم', en: 'We stay after handover' },
        body: {
          ar: 'التركيب والتدريب والدعم مش بنود إضافية في العرض. وأي سؤال بعد كده، اتصل أو ابعت واتساب — بنرد بنفسنا، مش روبوت ولا تذكرة.',
          en: 'Setup, training and support are not extra lines on the quote. Any question afterwards — call or WhatsApp, and you get us, not a bot and not a ticket number.',
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
    title: { ar: 'شوفها شغّالة قبل ما تقرر', en: 'See them working before you decide' },
    note: {
      ar: 'دي شاشات حقيقية من أنظمة شغالة عند عملائنا دلوقتي، مش رسومات.',
      en: 'Real screens from systems running with our clients today, not illustrations.',
    },
    items: [
      {
        key: 'pos',
        kind: 'desktop',
        caption: {
          ar: 'نظام المحلات — امسح الباركود والفاتورة جاهزة',
          en: 'The retail system — scan, and the invoice is ready',
        },
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
        key: 'products',
        kind: 'desktop',
        caption: { ar: 'كل صنف بمقاساته وكمياته', en: 'Every product, every size, every quantity' },
        enabled: true,
        custom: null,
      },
      {
        key: 'highlevel-home',
        kind: 'desktop',
        caption: {
          ar: 'High Level — موقع الشركة اللي بيجيب العملاء',
          en: 'High Level — the company website that brings the clients',
        },
        enabled: true,
        custom: null,
      },
      {
        key: 'highlevel-calc',
        kind: 'desktop',
        caption: {
          ar: 'العميل بيحسب قسطه بنفسه قبل ما يكلّمك',
          en: 'A client works out their own instalment before calling you',
        },
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
    title: { ar: 'شغّالين علينا دلوقتي', en: 'Running on Nexora today' },
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
    title: {
      ar: 'من أول مكالمة لحد ما النظام يشتغل — أربع خطوات',
      en: 'From the first call to a system that runs — four steps',
    },
    note: {
      ar: 'مفيش حاجة فيهم إنت اللي هتعملها لوحدك.',
      en: 'Not one of them is a thing you do on your own.',
    },
    items: [
      {
        title: { ar: 'نتكلم ونفهم شغلك', en: 'We talk, and we learn the business' },
        body: {
          ar: 'مكالمة قصيرة نفهم منها بتشتغل إزاي دلوقتي، وإيه اللي واجعك بالظبط، وأنهي نظام من التلاتة هو اللي يفيدك.',
          en: 'A short call: how you work today, what actually hurts, and which of the three is the one that helps.',
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

  // --- 8 · why not paper and Excel ----------------------------------------
  versus: {
    enabled: true,
    title: {
      ar: 'الورق والإكسل بيشتغلوا… لحد لما الشغل يكبر',
      en: 'Paper and a spreadsheet work — until the business grows',
    },
    rows: [
      {
        before: {
          ar: 'بتعرف عملت كام لما تقفل وتحسب بالإيد',
          en: 'You learn what you made by closing up and adding it by hand',
        },
        after: { ar: 'الرقم قدامك وإنت واقف', en: 'The number is in front of you while you stand there' },
      },
      {
        before: {
          ar: 'بتعرف الصنف أو الخامة خلصت لما تحتاجها وملاقيهاش',
          en: 'You learn a line or a material ran out when you reach for it and it is gone',
        },
        after: { ar: 'بيقولك قبل ما تخلص بكذا يوم', en: 'It warns you days before it runs out' },
      },
      {
        before: {
          ar: 'كل واحد في الفريق ماسك ملف لوحده، والأرقام مش بتطابق',
          en: 'Everyone keeps their own file, and the numbers never agree',
        },
        after: { ar: 'نظام واحد، وكل واحد بصلاحيته', en: 'One system, and each person with their own permissions' },
      },
      {
        before: {
          ar: 'لو الدفتر أو الملف ضاع، ضاع كل حاجة',
          en: 'If the notebook or the file goes missing, everything goes with it',
        },
        after: { ar: 'نسخة احتياطية تلقائية كل يوم', en: 'Backed up automatically, every day' },
      },
    ],
  },

  // --- 9 · who this is for ------------------------------------------------
  audience: {
    enabled: true,
    title: { ar: 'مناسب لشغلك؟', en: 'Is it right for your business?' },
    yesTitle: { ar: 'أيوه، لو إنت', en: 'Yes, if you are' },
    yes: [
      {
        ar: 'محل ملابس أو أحذية أو إكسسوارات أو عطور أو هدايا',
        en: 'A clothing, footwear, accessories, perfume or gift shop',
      },
      {
        ar: 'بتصنّع أو بتركّب عطور ومستحضرات تجميل',
        en: 'Manufacturing or compounding perfume and cosmetics',
      },
      { ar: 'شركة تشطيب أو ديكور أو مقاولات', en: 'A fit-out, interiors or contracting company' },
      {
        ar: 'أي شغل ماسك مخزن وتكاليف وعايز أرقامه تبقى مظبوطة',
        en: 'Any business holding stock and costs that wants its numbers to be right',
      },
    ],
    noTitle: { ar: 'بصراحة، مش مناسب لـ', en: 'Honestly, not built for' },
    no: [
      {
        ar: 'مطاعم وكافيهات — دي محتاجة نظام مطبخ وطاولات، وده مش شغلنا',
        en: 'Restaurants and cafés — those need kitchen and table management, which is not what we do',
      },
      {
        ar: 'حد عايز نظام ينزل بكرة من غير ما نفهم شغله الأول',
        en: 'Anyone who wants a system live tomorrow without us understanding the business first',
      },
    ],
    closing: {
      ar: 'لو مش متأكد، اتصل واسألنا. لو مش هنفيدك هنقولك، أحسن من إنك تدفع وتكتشف بنفسك.',
      en: 'Not sure? Call and ask. If it will not help you we will say so — better than you paying to find out.',
    },
  },

  // --- 10 · what clients say ----------------------------------------------
  // SHIPS EMPTY, and therefore invisible. No client has given one of these for
  // publication yet, and an invented testimonial on a page selling trust is
  // the fastest way to lose it — in a market this small the reader may know
  // the business being quoted. The heading is written and waiting; the
  // section appears the day a real quote is entered.
  quotes: {
    enabled: true,
    title: { ar: 'ناس شغالة علينا', en: 'What our clients say' },
    items: [],
  },

  // --- 11 · request a quote -----------------------------------------------
  demo: {
    title: { ar: 'اطلب عرض سعر، من غير أي التزام', en: 'Ask for a quote, with no commitment' },
    body: {
      ar: 'احجز نص ساعة معانا. هنفهم شغلك، ونوريك النظام المناسب شغّال على بيانات شبه بتاعتك، ونبعتلك عرض سعر مكتوب — وبعدها إنت اللي تقرر.',
      en: 'Book half an hour with us. We will understand the business, show you the right system running on data like yours, and send you a written quote — then you decide.',
    },
    button: { ar: 'اطلب عرض سعر على واتساب', en: 'Request a quote on WhatsApp' },
    small: {
      ar: 'بنرد في نفس اليوم. من غير بيانات بنك ولا دفع مقدم.',
      en: 'We reply the same day. No bank details, nothing paid up front.',
    },
    fields: {
      name: { ar: 'الاسم', en: 'Name' },
      phone: { ar: 'رقم الموبايل', en: 'Mobile number' },
      shopType: {
        ar: 'النظام اللي يهمك (محلات / ChemCost / High Level)',
        en: 'Which system interests you (Retail / ChemCost / High Level)',
      },
      branches: { ar: 'نوع نشاطك', en: 'What your business does' },
      message: { ar: 'حابب تسألنا عن إيه؟', en: 'Anything you want to ask?' },
    },
  },

  // --- 12 · FAQ -----------------------------------------------------------
  faq: {
    enabled: true,
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
    line: {
      ar: 'نكسورا — أنظمة إدارة وبرمجيات للشركات في مصر',
      en: 'Nexora — business systems and software, built in Egypt',
    },
    madeIn: { ar: 'صُنع في مصر، لشغل في مصر', en: 'Made in Egypt, for businesses in Egypt' },
    rights: { ar: '© 2026 Nexora. كل الحقوق محفوظة.', en: '© 2026 Nexora. All rights reserved.' },
  },
};
