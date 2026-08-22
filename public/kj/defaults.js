/**
 * The words the KJ landing page ships with.
 *
 * This is the whole page as a document: every string in both languages, every
 * package and its bullets, every FAQ entry, every caption. `kj.js` renders it,
 * and the HTML next door is this same content already written out — so a
 * visitor whose JavaScript never runs reads the same page.
 *
 * It is a module of its own, and that is the point. THREE readers need this
 * object and none of them may hold a second copy of it:
 *
 *   - `kj.js`, which renders it and then merges the owner's stored document
 *     over it;
 *   - the KJ Admin editor (`public/platform/js/views/landing.js`), which shows
 *     an unedited field with the text a visitor is actually reading, and which
 *     could not offer "restore the original" without knowing what the original
 *     said;
 *   - a reader deciding what a section is for.
 *
 * The editor used to lift this literal out of `kj.js` by brace-matching its
 * source text, because `kj.js` exports nothing and importing it runs the whole
 * landing page's boot sequence — which would have repainted the console's own
 * theme out from under it. That bridge worked and would have broken on the
 * first refactor of that file. This file is the one line that retired it.
 *
 * Nothing here is markup. Nothing here names KJ Admin: the console is the
 * owner's, not a thing a customer can buy, and a price card that mentions it
 * only invites a question whose answer is no.
 */

export const DEFAULTS = {
  version: 1,

  brand: {
    name: { ar: 'KJ', en: 'KJ' },
    tagline: {
      ar: 'KJ — إدارة محلات وبيع أونلاين',
      en: 'KJ — shop management and online selling',
    },
    /** ONE hex. Every shade the sheet paints with is derived from it. */
    accent: '#4f46e5',
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
      ar: 'KJ — نظام إدارة محلات وموقع بيع أونلاين في مصر',
      en: 'KJ — Shop management and online store, built in Egypt',
    },
    description: {
      ar: 'امسك مخزنك ومبيعاتك وافتح موقع بيع أونلاين باسم محلك، من منصة واحدة بالعربي. باقات من ٢٬٠٠٠ جنيه شهريًا.',
      en: 'Manage stock and sales and open your own online shop, from one Arabic platform. Packages from 2,000 EGP a month.',
    },
  },

  // --- 1 · hero ----------------------------------------------------------
  hero: {
    eyebrow: {
      ar: 'نظام إدارة محلات وبيع أونلاين — مصري ١٠٠٪',
      en: 'Shop management and online selling — built in Egypt',
    },
    title: { ar: 'إدارة محلك ومبيعاتك من مكان واحد', en: 'Run your whole shop from one screen' },
    subtitle: {
      ar: 'مخزن، كاشير، فواتير، تقارير، وموقع بيع أونلاين — كله في منصة واحدة بتشتغل بالعربي، وسهلة لدرجة إن أي حد في المحل يقدر يستخدمها من أول يوم.',
      en: 'Stock, till, invoices, reports and your own online shop — one platform, in Arabic, simple enough that anyone on your team can use it from day one.',
    },
    primaryCta: { ar: 'اطلب عرض توضيحي', en: 'Request a Demo' },
    secondaryCta: { ar: 'شوف الباقات والأسعار', en: 'See packages and pricing' },
    trust: [
      { ar: 'بيشتغل من غير نت في المحل', en: 'Works in-store even when the internet drops' },
      { ar: 'عربي وإنجليزي بالكامل', en: 'Fully Arabic and English' },
      { ar: 'تركيب وتدريب من غير أي رسوم إضافية', en: 'Setup and training included, no extra fee' },
    ],
    image: null,
  },

  // --- 2 · business overview ---------------------------------------------
  overview: {
    title: {
      ar: 'محلك شغّال… بس شغلك مش متجمّع في مكان واحد',
      en: 'Your shop is busy — but nothing is in one place',
    },
    intro: {
      ar: 'أغلب أصحاب المحلات في مصر بيمسكوا المخزن في كشكول، المبيعات في تليفون، والطلبات أونلاين في رسايل واتساب. كل حاجة شغالة، بس محدش يعرف بالظبط باع كام، ولا فاضل كام، ولا إيه اللي بيجيب فلوس فعلًا. KJ بيجمع ده كله في منصة واحدة.',
      en: 'Most shop owners in Egypt keep stock in a notebook, sales on a phone, and online orders in WhatsApp messages. It all works — until you try to answer a simple question: what sold, what is left, and what actually makes money. KJ puts all of it in one place.',
    },
    blocks: [
      {
        icon: 'till',
        title: { ar: 'بِع واحسب في ثانية', en: 'Sell and settle in seconds' },
        body: {
          ar: 'افتح شاشة الكاشير، امسح الباركود، والفاتورة تطلع. المخزون بيتخصم لوحده، والوردية بتتقفل في آخر اليوم بأرقام صح من غير حسبة على ورق.',
          en: 'Open the till, scan the barcode, print the invoice. Stock comes down by itself and the shift closes at the end of the day with numbers you can trust — no paper arithmetic.',
        },
      },
      {
        icon: 'boxes',
        title: { ar: 'اعرف مخزنك بالظبط', en: 'Know exactly what you have' },
        body: {
          ar: 'كل صنف بمقاساته وألوانه وسعره وباركود خاص بيه. اطبع ملصقات باركود بنفسك، اعمل جرد، وشوف اللي قرب يخلص قبل ما العميل يسألك عليه.',
          en: 'Every item with its sizes, colours, price and its own barcode. Print your own barcode labels, run a stock count, and see what is about to run out before a customer asks for it.',
        },
      },
      {
        icon: 'globe-bag',
        title: { ar: 'وسّع وابيع أونلاين', en: 'Open online, without starting over' },
        body: {
          ar: 'بضغطة واحدة يبقى عندك موقع بيع باسم محلك، بلوجو وألوانك، والدفع عند الاستلام. الطلب اللي بييجي من الموقع بيدخل على نفس النظام — نفس المخزون، نفس الفواتير، نفس التقارير.',
          en: 'One switch and you have an online shop under your own name, your logo, your colours, with cash on delivery. An order from the website lands in the same system — same stock, same invoices, same reports.',
        },
      },
    ],
    closing: {
      ar: 'محل واحد أو خمسة، وأونلاين وأوفلاين — نفس الأرقام، ومكان واحد بتتفرج منه على كل حاجة.',
      en: 'One branch or five, online and in-store — the same numbers, in one place you can actually look at.',
    },
  },

  // --- 3 · how it works ---------------------------------------------------
  steps: {
    enabled: true,
    title: {
      ar: 'من أول مكالمة لحد ما تبيع — أربع خطوات',
      en: 'From the first call to your first sale — four steps',
    },
    note: { ar: 'مفيش حاجة إنت اللي هتعملها لوحدك.', en: 'None of this is a thing you do on your own.' },
    items: [
      {
        title: { ar: 'نتكلم ونشوف محلك', en: 'We talk, and we look at your shop' },
        body: {
          ar: 'مكالمة قصيرة نفهم منها بتبيع إيه، وعندك كام صنف، وشغال إزاي دلوقتي.',
          en: 'A short call: what you sell, how many lines you carry, and how you work today.',
        },
      },
      {
        title: { ar: 'بنركّب وننقل بياناتك', en: 'We install it and move your data' },
        body: {
          ar: 'بنجهّز النظام ونحطّ أصنافك وأسعارك جواه. مش هتقعد تكتبهم من أول وجديد.',
          en: 'We set the system up with your products and your prices in it. You do not retype them.',
        },
      },
      {
        title: { ar: 'بندرّب فريقك', en: 'We train your team' },
        body: {
          ar: 'ساعة أو اتنين مع الكاشير وصاحب المحل. الشاشة بالعربي، وأغلب الناس بتتعلم في يوم.',
          en: 'An hour or two with the cashier and the owner. The screen is in Arabic, and most people have it in a day.',
        },
      },
      {
        title: { ar: 'تشتغل، وإحنا معاك', en: 'You start, and we stay with you' },
        body: {
          ar: 'تبدأ تبيع من أول يوم. أي سؤال، اتصل أو ابعت واتساب — بنرد بنفسنا.',
          en: 'You sell from day one. Any question, call or WhatsApp — you get us, not a queue.',
        },
      },
    ],
  },

  // --- 4 · who this is for ------------------------------------------------
  audience: {
    enabled: true,
    title: { ar: 'مناسب لمحلك؟', en: 'Is it right for your shop?' },
    yesTitle: { ar: 'أيوه، لو بتبيع', en: 'Yes, if you sell' },
    yes: [
      { ar: 'ملابس وأحذية — بمقاسات وألوان', en: 'Clothes and shoes — with sizes and colours' },
      { ar: 'عطور وإكسسوارات وهدايا', en: 'Perfume, accessories and gifts' },
      { ar: 'شنط ومحافظ وساعات', en: 'Bags, wallets and watches' },
      { ar: 'أي بضاعة بتتباع بالقطعة ولها كود', en: 'Anything sold by the piece that carries a code' },
    ],
    noTitle: { ar: 'بصراحة، مش مناسب لـ', en: 'Honestly, not built for' },
    no: [
      {
        ar: 'مطاعم وكافيهات — دي محتاجة نظام مطبخ وطاولات، وده مش شغلنا',
        en: 'Restaurants and cafés — those need kitchen and table management, which is not what this is',
      },
      {
        ar: 'محلات بتبيع بالوزن بس، من غير أصناف ثابتة',
        en: 'Shops that sell only by weight, with no fixed product lines',
      },
    ],
    closing: {
      ar: 'لو مش متأكد، اتصل واسألنا. لو النظام مش هيفيدك هنقولك، أحسن من إنك تدفع وتكتشف بنفسك.',
      en: 'Not sure? Call and ask. If it will not help you we will say so — better than you paying to find out.',
    },
  },

  // --- 5 · why not a notebook or Excel ------------------------------------
  versus: {
    enabled: true,
    title: {
      ar: 'الدفتر والإكسل بيشتغلوا… لحد لما محلك يكبر',
      en: 'A notebook and a spreadsheet work — until your shop grows',
    },
    rows: [
      {
        before: {
          ar: 'بتعرف باعت كام لما تقفل وتحسب بالإيد',
          en: 'You learn what you sold by closing up and adding it by hand',
        },
        after: { ar: 'الرقم قدامك وإنت واقف', en: 'The number is in front of you while you stand there' },
      },
      {
        before: {
          ar: 'بتعرف الصنف خلص لما عميل يطلبه ومتلاقيهوش',
          en: 'You learn a line ran out when a customer asks and it is not there',
        },
        after: { ar: 'بيقولك قبل ما يخلص بكذا يوم', en: 'It warns you days before it runs out' },
      },
      {
        before: { ar: 'الموظف بيسجل السعر اللي فاكره', en: 'Your employee charges the price he remembers' },
        after: { ar: 'السعر واحد، جاي من النظام', en: 'One price, and it comes from the system' },
      },
      {
        before: { ar: 'لو الدفتر ضاع، ضاع كل حاجة', en: 'If the notebook goes missing, everything goes with it' },
        after: { ar: 'نسخة احتياطية تلقائية كل يوم', en: 'Backed up automatically, every day' },
      },
    ],
  },

  // --- 6 · packages -------------------------------------------------------
  packages: {
    title: { ar: 'باقات واضحة، من غير مفاجآت', en: 'Clear packages, no surprises' },
    note: {
      ar: 'كل الباقات شاملة التركيب والتدريب والتحديثات. من غير عقد سنة، تقدر تغيّر باقتك أو توقف في أي وقت.',
      en: 'Every package includes setup, training and updates. No annual contract — change or cancel any time.',
    },
    reassure: {
      ar: 'مش متأكد أنهي باقة تناسبك؟ احجز عرض توضيحي، نشوف محلك مع بعض ونقولك بصراحة إنت محتاج إيه.',
      en: 'Not sure which package fits? Book a demo — we will look at your shop together and tell you honestly what you need.',
    },
    currency: { ar: 'جنيه', en: 'EGP' },
    period: { ar: '/ شهريًا', en: '/ month' },
    items: [
      {
        id: 'starter',
        name: { ar: 'البداية', en: 'Starter' },
        price: 2000,
        badge: null,
        featured: false,
        oneLiner: {
          ar: 'للمحل الواحد اللي عايز يمسك مخزنه ومبيعاته صح',
          en: 'For a single shop that wants its stock and sales under control',
        },
        inherits: null,
        features: [
          {
            ar: 'شاشة كاشير كاملة مع دعم قارئ الباركود — امسح، والفاتورة تطلع',
            en: 'A full till with barcode-scanner support — scan, and the invoice prints',
          },
          {
            ar: 'مخزون بأصناف ومقاسات وألوان، وتنبيه قبل ما الصنف يخلص',
            en: 'Stock with products, sizes and colours, and a warning before a line runs out',
          },
          {
            ar: 'فواتير، مرتجعات، وتقفيل وردية في آخر اليوم بأرقام صح',
            en: 'Invoices, returns, and an end-of-day shift close with numbers that add up',
          },
          {
            ar: 'تقارير المبيعات: إيه اللي بيتباع، وإيه اللي واقف من شهور',
            en: 'Sales reports: what is selling, and what has been sitting for months',
          },
          { ar: 'مستخدمين اتنين — صاحب المحل وكاشير', en: 'Two users — the owner and a cashier' },
        ],
        cta: { ar: 'ابدأ بالبداية', en: 'Start with Starter' },
      },
      {
        id: 'growth',
        name: { ar: 'التوسّع', en: 'Growth' },
        price: 3500,
        badge: { ar: 'الأكثر طلبًا', en: 'Most popular' },
        featured: true,
        oneLiner: {
          ar: 'لما تبقى عايز تبيع أونلاين من غير ما تسيب المحل',
          en: 'For when you want to sell online without leaving the counter',
        },
        inherits: { ar: 'كل اللي في باقة البداية، وكمان:', en: 'Everything in Starter, plus:' },
        features: [
          {
            ar: 'موقع بيع أونلاين باسم محلك، بلوجو وألوانك، عربي وإنجليزي',
            en: 'An online shop under your name, with your logo and colours, in Arabic and English',
          },
          {
            ar: 'الدفع عند الاستلام، وشحن إنت اللي بتحدده — مبلغ ثابت أو نسبة من الطلب',
            en: 'Cash on delivery, and shipping you decide — a flat amount or a percentage of the order',
          },
          {
            ar: 'طلب الموقع بيدخل على نفس النظام وبيتخصم من نفس المخزون، من غير نقل بالإيد',
            en: 'A website order lands in the same system and comes off the same stock — nothing retyped',
          },
          {
            ar: 'اطبع ملصقات الباركود بنفسك، بسعر الصنف واسمه',
            en: 'Print your own barcode labels, with the price and the name on them',
          },
          { ar: '٥ مستخدمين، كل واحد بصلاحياته', en: '5 users, each with their own permissions' },
        ],
        cta: { ar: 'ابدأ التوسّع', en: 'Start with Growth' },
      },
      {
        id: 'premium',
        name: { ar: 'الاحترافية', en: 'Premium' },
        price: 6000,
        badge: null,
        featured: false,
        oneLiner: {
          ar: 'لأكتر من فرع، ولما المحل يبقى شغل كبير محتاج ترتيب',
          en: 'For more than one branch, and for a business that has outgrown being watched by one person',
        },
        inherits: { ar: 'كل اللي في باقة التوسّع، وكمان:', en: 'Everything in Growth, plus:' },
        features: [
          {
            ar: 'فروع ومحلات متعددة — كل فرع ببياناته ولوجوه وموقعه، وتقدر تقارن بينهم',
            en: 'Multiple branches and shops — each with its own data, logo and website, and comparable side by side',
          },
          {
            ar: 'مستخدمين بلا حد، وصلاحيات بتحددها بالتفصيل لكل موظف',
            en: 'Unlimited users, with permissions you set in detail for each employee',
          },
          {
            ar: 'تقارير متقدمة: أرباح، موردين، حركة مخزون، ومقارنة بين الفروع',
            en: 'Advanced reports: profit, suppliers, stock movement, and branch against branch',
          },
          {
            ar: 'بننقل بياناتك القديمة بنفسنا — أصنافك وأسعارك وعملاءك',
            en: 'We move your existing data ourselves — your products, your prices, your customers',
          },
          {
            ar: 'نسخة احتياطية تلقائية، وتدريب لكل الفريق مش لصاحب المحل بس، ودعم بأولوية',
            en: 'Automatic backups, training for the whole team rather than just the owner, and priority support',
          },
        ],
        cta: { ar: 'اطلب باقة الاحترافية', en: 'Get Premium' },
      },
    ],
  },

  // --- 7 · in every package -----------------------------------------------
  included: {
    enabled: true,
    title: { ar: 'كل الباقات فيها، من غير فلوس زيادة', en: 'In every package, at no extra cost' },
    items: [
      { ar: 'التركيب والتجهيز', en: 'Setup and installation' },
      { ar: 'تدريب فريقك', en: 'Training for your team' },
      { ar: 'التحديثات أول بأول', en: 'Updates as they come' },
      { ar: 'دعم بالعربي، من بني آدم', en: 'Support in Arabic, from a person' },
      { ar: 'من غير عقد سنة — توقف في أي وقت', en: 'No annual contract — stop whenever you like' },
      { ar: 'بياناتك بتاعتك، وتقدر تاخد نسخة منها', en: 'Your data is yours, and you can take a copy of it' },
    ],
  },

  // --- 8 · screenshots ----------------------------------------------------
  shots: {
    title: { ar: 'شوفه شغّال قبل ما تقرر', en: 'See it working before you decide' },
    note: { ar: 'دي شاشات حقيقية من النظام، مش رسومات.', en: 'These are real screens from the system, not illustrations.' },
    items: [
      {
        key: 'pos',
        kind: 'desktop',
        caption: { ar: 'شاشة الكاشير — امسح الباركود والفاتورة جاهزة', en: 'The till — scan, and the invoice is ready' },
        enabled: true,
        custom: null,
      },
      {
        key: 'dashboard',
        kind: 'desktop',
        caption: { ar: 'أرقام محلك في لمحة', en: "Your shop's numbers at a glance" },
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
        key: 'weborders',
        kind: 'desktop',
        caption: { ar: 'الطلب من الموقع بيوصلك في نفس النظام', en: 'A website order arrives inside the same system' },
        enabled: true,
        custom: null,
      },
      {
        key: 'shop-home',
        kind: 'phone',
        caption: { ar: 'موقعك باسمك وألوانك', en: 'Your website, your name, your colours' },
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

  // --- 9 · what shop owners say -------------------------------------------
  // SHIPS EMPTY, and therefore invisible. No customer has said one of these
  // yet, and an invented testimonial on a page selling trust is the fastest
  // way to lose it — in a market this small the reader may know the shop being
  // quoted. The heading is written and waiting; the section appears the day a
  // real quote is entered.
  quotes: {
    enabled: true,
    title: { ar: 'ناس شغالة عليه', en: 'Shops already running on it' },
    items: [],
  },

  // --- 10 · book a demo ---------------------------------------------------
  demo: {
    title: { ar: 'جرّب النظام بنفسك، من غير أي التزام', en: 'Try the system yourself, with no commitment' },
    body: {
      ar: 'احجز نص ساعة معانا. هنفتحلك النظام بمنتجات شبه بتاعتك، ونوريك إزاي المحل والموقع بيشتغلوا مع بعض — وبعدها إنت اللي تقرر.',
      en: 'Book half an hour with us. We will open the system with products like yours and show you how the shop and the website work together — then you decide.',
    },
    button: { ar: 'احجز عرض توضيحي مجاني', en: 'Book a free demo' },
    small: {
      ar: 'بنرد في نفس اليوم. من غير بيانات بنك ولا دفع مقدم.',
      en: 'We reply the same day. No bank details, nothing paid up front.',
    },
    fields: {
      name: { ar: 'الاسم', en: 'Name' },
      phone: { ar: 'رقم الموبايل', en: 'Mobile number' },
      shopType: { ar: 'نوع المحل (ملابس، عطور، إكسسوارات…)', en: 'Type of shop (clothes, perfume, accessories…)' },
      branches: { ar: 'عدد الفروع', en: 'Number of branches' },
      message: { ar: 'حابب تسألنا عن إيه؟', en: 'Anything you want to ask?' },
    },
  },

  // --- 11 · FAQ -----------------------------------------------------------
  faq: {
    enabled: true,
    title: { ar: 'أسئلة بتتسأل كتير', en: 'Questions we get a lot' },
    items: [
      {
        q: { ar: 'النت بيقطع عندي — هعمل إيه؟', en: 'My internet cuts out — what then?' },
        a: {
          ar: 'الكاشير بيشتغل على جهاز المحل نفسه، فلو النت راح البيع ما بيقفش.',
          en: 'The till runs on the shop’s own computer, so a dropped connection does not stop you selling.',
        },
      },
      {
        q: { ar: 'موظفيني مش بيعرفوا كمبيوتر.', en: 'My staff are not computer people.' },
        a: {
          ar: 'الشاشة بالعربي وكبيرة، والتدريب داخل الباقة. أغلب الكاشيرات بيتعلموا في يوم.',
          en: 'The screen is in Arabic and it is big, and training is in the package. Most cashiers pick it up in a day.',
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
        q: { ar: 'بدفع شهري؟ ولو وقفت؟', en: 'Is it monthly? And if I stop?' },
        a: {
          ar: 'شهري، ومن غير عقد سنة. توقف في أي وقت وبياناتك تفضل بتاعتك — تقدر تطلب نسخة منها.',
          en: 'Monthly, with no annual contract. Stop whenever you want; your data stays yours and you can ask for a copy.',
        },
      },
      {
        q: { ar: 'عندي أكتر من فرع، هيشوفوا بعض؟', en: 'I have more than one branch — will they see each other?' },
        a: {
          ar: 'كل فرع ليه مخزنه وكاشيره، وإنت بتشوفهم كلهم مع بعض وتقارن بينهم.',
          en: 'Each branch has its own stock and its own till, and you see them together and compare them.',
        },
      },
      {
        q: { ar: 'عندي أصناف كتير، هدخّلها إزاي؟', en: 'I have a lot of products — how do I get them in?' },
        a: {
          ar: 'إحنا بندخّلها. ابعتلنا اللي عندك بأي شكل — إكسل، صور، حتى كشكول — وإحنا بنجهّزه.',
          en: 'We put them in. Send us whatever you have — a spreadsheet, photos, even a notebook — and we prepare it.',
        },
      },
      {
        q: { ar: 'قارئ الباركود لازم أشتريه منكم؟', en: 'Do I have to buy the barcode scanner from you?' },
        a: {
          ar: 'لأ. أي قارئ USB عادي بيشتغل، ولو عندك واحد بالفعل بنظبّطه معاك.',
          en: 'No. Any ordinary USB scanner works, and if you already have one we will set it up with you.',
        },
      },
    ],
  },

  // --- 12 · the last ask --------------------------------------------------
  closing: {
    enabled: true,
    title: { ar: 'محلك يستاهل يبقى مرتب', en: 'Your shop deserves to be in order' },
    body: {
      ar: 'ابدأ بمكالمة. لو النظام مش مناسب لك هنقولك.',
      en: 'Start with a phone call. If it is not right for you, we will tell you.',
    },
    primaryCta: { ar: 'احجز عرض توضيحي', en: 'Book a demo' },
    secondaryCta: { ar: 'كلّمنا على واتساب', en: 'Message us on WhatsApp' },
  },

  footer: {
    line: { ar: 'KJ — إدارة محلات وبيع أونلاين', en: 'KJ — shop management and online selling' },
    madeIn: { ar: 'صُنع في مصر لأصحاب المحلات في مصر', en: 'Made in Egypt, for shop owners in Egypt' },
    rights: { ar: '© 2026 KJ. كل الحقوق محفوظة.', en: '© 2026 KJ. All rights reserved.' },
  },
};
