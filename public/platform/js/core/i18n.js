/**
 * Bilingual dictionary for the platform dashboard. A separate dictionary
 * from the ERP's on purpose (own app, own file ownership) but the module
 * labels reuse the exact same English/Arabic wording as the ERP sidebar, so
 * an owner who also opens a shop's own ERP sees the same names for the same
 * things.
 */

const dictionary = {
  en: {
    platformName: 'M&M Platform', platformTag: 'Fleet console — every shop, one place',
    signIn: 'Sign in', signOut: 'Sign out', username: 'Username', password: 'Password',
    signingIn: 'Signing in…', welcome: 'Owner console', signInSubtitle: 'Sign in with your platform account',
    versionTag: 'v1.0 · Fleet control',
    showPassword: 'Show password', hidePassword: 'Hide password',
    invalidCredentials: 'Invalid username or password',
    firstRunTitle: 'Set up your console',
    firstRunSubtitle: 'Nobody owns this console yet. Choose the password you will sign in with.',
    firstRunUsername: 'Your username will be "owner".',
    choosePassword: 'Password', choosePasswordHint: 'At least 8 characters. Only its hash is stored.',
    confirmPassword: 'Repeat the password',
    createOwner: 'Create the owner account',
    passwordTooShort: 'Choose a password of at least 8 characters',
    passwordsDoNotMatch: 'The two passwords are not the same',
    language: 'Language', english: 'English', arabic: 'العربية',

    tenants: 'Tenants', migrations: 'Migrations',
    tenantsSubtitle: 'Every shop on this server, its plan and its health',
    newTenant: 'New tenant', search: 'Search name or slug…', status: 'Status',
    allStatuses: 'All statuses', active: 'Active', suspended: 'Suspended',
    name: 'Name', slug: 'Slug', modules: 'Modules', created: 'Created', stats: 'Activity',
    website: 'Website', on: 'On', off: 'Off', manage: 'Manage',
    noTenantsTitle: 'No shops yet', noTenantsBody: 'Create your first tenant to provision its database, admin account and modules.',
    noResults: 'Nothing matches this filter', loading: 'Loading…',

    usersStat: 'users', productsStat: 'products', sales30dStat: 'sales / 30d', lastActive: 'Last active',
    never: 'Never',

    // create tenant
    createTenant: 'Create tenant', nameEn: 'Shop name (English)', nameAr: 'Shop name (Arabic)',
    slugHint: 'Lowercase letters, digits and hyphens, 2–31 characters, starting with a letter or digit.',
    slugAuto: 'Suggested from the English name — edit freely.',
    slugReserved: '"{slug}" is a reserved word and cannot be used as a slug',
    slugInvalid: 'Slug must be lowercase letters, digits and hyphens, 2-31 characters, starting with a letter or digit',
    slugRequired: 'Slug is required',
    nameEnRequired: 'Shop name (English) is required',
    modulesHint: 'What this shop can use. The server enforces this — the ERP sidebar only reflects it.',
    websiteEnabled: 'Website enabled', websiteEnabledHint: 'Off = no storefront, /shop returns 404 for this tenant.',
    maxUsers: 'Max users', maxProducts: 'Max products', unlimitedHint: 'Blank or 0 = unlimited',
    create: 'Create', creating: 'Creating…',

    // where the shop's data lives
    dataLocation: 'Where does this shop\'s data live?',
    dataLocationFile: 'On this machine (file)',
    dataLocationHosted: 'Turso database (for the internet)',
    dataLocationFileHint: 'A SQLite file in the platform\'s data folder. Fine on a shop PC or a LAN server.',
    dataLocationHostedHint: 'An existing Turso database. If it already has a shop in it, that shop is adopted as it is — nothing is seeded and nothing is overwritten.',
    dataLocationHostedOnly: 'This platform is running on a hosted deployment, which has no disk of its own. A file cannot work here — every shop needs its own Turso database.',
    dbUrl: 'Database URL', dbToken: 'Auth token',
    dbUrlHint: 'Starts with libsql:// or https:// — copy it from the database\'s page in Turso.',
    dbTokenHint: 'Sent once and kept by the server. It is never shown again and never returned by the API.',
    dbUrlRequired: 'A database URL is required',
    dbUrlInvalid: 'A database URL must start with libsql:// or https://',
    dataLocationLabel: 'Data', dataLocationFileShort: 'File', dataLocationHostedShort: 'Turso',
    tokenSet: 'auth token set', tokenNotSet: 'no auth token',

    // adoption
    tenantAdopted: 'Existing shop adopted',
    tenantAdoptedHeadline: 'This database already had a shop in it, so it was attached exactly as it was.',
    tenantAdoptedBody: 'Nothing was seeded, no setting was changed and no password was generated. Everyone who already used this shop signs in exactly as they did before.',
    adoptedFound: 'Found in this database',

    // one-time password
    oneTimePassword: 'Admin password', oneTimePasswordHint: 'Shown once, right now. It is never stored in the clear and will not be shown again — write it down or copy it before closing this dialog.',
    tenantCreated: 'Tenant created — hand this password to the shop owner',
    passwordReset: 'Password reset — hand this password to the shop owner',
    adminAccount: 'Admin account', copyToClipboard: 'Copy', copied: 'Copied',
    copyManually: 'Copying is blocked here — the password is selected, press Ctrl+C',
    openErp: 'Open ERP', openStorefront: 'Open storefront',

    // manage tenant
    backToTenants: 'Back to tenants', tenantDetails: 'Tenant details',
    editTenant: 'Edit details', save: 'Save', saved: 'Saved', cancel: 'Cancel',
    dangerZone: 'Danger zone', suspendTenant: 'Suspend shop', resumeTenant: 'Resume shop',
    suspendConfirmTitle: 'Suspend this shop?',
    suspendConfirmBody: 'The ERP and storefront both stop answering immediately — every request returns "temporarily unavailable" (HTTP 423) until it is resumed. Nothing is deleted; the shop\'s data and database are untouched.',
    resumeConfirmTitle: 'Resume this shop?',
    resumeConfirmBody: 'The ERP and storefront start answering again immediately, exactly as they were before suspension.',
    suspended_action: 'Suspended', resumed_action: 'Resumed',
    resetAdminPassword: 'Reset admin password',
    resetAdminConfirmTitle: 'Reset the admin password?',
    resetAdminConfirmBody: 'A new one-time password is generated for this shop\'s "admin" account. The old password stops working immediately.',
    notes: 'Notes', createdAt: 'Created', updatedAt: 'Last updated',

    // migrations
    migrationsSubtitle: 'Apply schema and migrations to every active shop in one pass',
    runMigration: 'Run migration across the fleet',
    runningMigration: 'Running…', migrationHint: 'Suspended shops are skipped — resume a shop first if it needs the update.',
    migrationResults: 'Last run', migratedOk: 'Updated', migratedNone: 'Nothing to apply', migratedError: 'Failed',
    migrationEmpty: 'Run the fleet migration to see a per-tenant report here.',
    applied: 'Applied', error: 'Error', tenant: 'Tenant', outcome: 'Outcome',
    migrationSummary: '{ok} of {total} shop(s) updated cleanly',
    migrationSummaryWithErrors: '{ok} of {total} shop(s) updated cleanly — {failed} failed',
    noneApplied: '— nothing new —',

    required: 'Required', somethingWrong: 'Something went wrong', close: 'Close', confirm: 'Confirm', yes: 'Yes',
  },

  ar: {
    platformName: 'منصّة إم آند إم', platformTag: 'لوحة إدارة الأسطول — كل المتاجر في مكان واحد',
    signIn: 'تسجيل الدخول', signOut: 'تسجيل الخروج', username: 'اسم المستخدم', password: 'كلمة المرور',
    signingIn: 'جارٍ تسجيل الدخول…', welcome: 'لوحة المالك', signInSubtitle: 'سجّل الدخول بحساب المنصّة',
    showPassword: 'إظهار كلمة المرور', hidePassword: 'إخفاء كلمة المرور',
    invalidCredentials: 'اسم المستخدم أو كلمة المرور غير صحيحة',
    firstRunTitle: 'جهّز لوحتك',
    firstRunSubtitle: 'اللوحة دي لسه مالهاش مالك. اختار كلمة المرور اللي هتدخل بيها.',
    firstRunUsername: 'اسم المستخدم هيكون "owner".',
    choosePassword: 'كلمة المرور', choosePasswordHint: '٨ حروف على الأقل. بنخزّن بصمتها فقط.',
    confirmPassword: 'أعد كتابة كلمة المرور',
    createOwner: 'إنشاء حساب المالك',
    passwordTooShort: 'اختار كلمة مرور ٨ حروف على الأقل',
    passwordsDoNotMatch: 'كلمتا المرور غير متطابقتين',
    language: 'اللغة', english: 'English', arabic: 'العربية',

    tenants: 'المتاجر', migrations: 'التحديثات',
    tenantsSubtitle: 'كل متجر على هذا السيرفر، خطته وحالته',
    newTenant: 'متجر جديد', search: 'ابحث بالاسم أو الرابط…', status: 'الحالة',
    allStatuses: 'كل الحالات', active: 'مفعّل', suspended: 'موقوف',
    name: 'الاسم', slug: 'الرابط المختصر', modules: 'الوحدات', created: 'تاريخ الإنشاء', stats: 'النشاط',
    website: 'الموقع الإلكتروني', on: 'مفعّل', off: 'موقوف', manage: 'إدارة',
    noTenantsTitle: 'لا توجد متاجر بعد', noTenantsBody: 'أنشئ أول متجر لإعداد قاعدة بياناته وحساب المدير والوحدات المفعّلة.',
    noResults: 'لا يوجد ما يطابق هذا الفلتر', loading: 'جارٍ التحميل…',

    usersStat: 'مستخدم', productsStat: 'منتج', sales30dStat: 'مبيعات / ٣٠ يوم', lastActive: 'آخر نشاط',
    never: 'أبدًا',

    createTenant: 'إنشاء متجر', nameEn: 'اسم المتجر (إنجليزي)', nameAr: 'اسم المتجر (عربي)',
    slugHint: 'أحرف إنجليزية صغيرة وأرقام وشرطات، من ٢ إلى ٣١ حرفًا، يبدأ بحرف أو رقم.',
    slugAuto: 'مقترح من الاسم الإنجليزي — يمكنك تعديله بحرية.',
    slugReserved: '"{slug}" كلمة محجوزة ولا يمكن استخدامها كرابط',
    slugInvalid: 'الرابط يجب أن يكون أحرف إنجليزية صغيرة وأرقام وشرطات، من ٢ إلى ٣١ حرفًا، ويبدأ بحرف أو رقم',
    slugRequired: 'الرابط المختصر مطلوب',
    nameEnRequired: 'اسم المتجر بالإنجليزية مطلوب',
    modulesHint: 'ما يمكن لهذا المتجر استخدامه. الخادم هو من يفرض هذا — قائمة الشريط الجانبي في الـERP تعكسه فقط.',
    websiteEnabled: 'الموقع الإلكتروني مفعّل', websiteEnabledHint: 'إيقافه يعني عدم وجود متجر إلكتروني — /shop يرجع 404 لهذا المتجر.',
    maxUsers: 'أقصى عدد مستخدمين', maxProducts: 'أقصى عدد منتجات', unlimitedHint: 'فارغ أو ٠ = بلا حد',
    create: 'إنشاء', creating: 'جارٍ الإنشاء…',

    dataLocation: 'أين تُحفظ بيانات هذا المتجر؟',
    dataLocationFile: 'على هذا الجهاز (ملف)',
    dataLocationHosted: 'قاعدة بيانات Turso (للإنترنت)',
    dataLocationFileHint: 'ملف SQLite داخل مجلد بيانات المنصّة. مناسب لجهاز المتجر أو سيرفر الشبكة المحلية.',
    dataLocationHostedHint: 'قاعدة بيانات Turso موجودة بالفعل. إذا كانت تحتوي على متجر قائم، يتم ضمّه كما هو — بلا أي تهيئة وبلا الكتابة فوق أي شيء.',
    dataLocationHostedOnly: 'هذه المنصّة تعمل على استضافة بلا قرص تخزين خاص بها، لذلك لا يصلح استخدام ملف هنا — كل متجر يحتاج قاعدة بيانات Turso خاصة به.',
    dbUrl: 'رابط قاعدة البيانات', dbToken: 'رمز الدخول',
    dbUrlHint: 'يبدأ بـ libsql:// أو https:// — انسخه من صفحة قاعدة البيانات في Turso.',
    dbTokenHint: 'يُرسل مرة واحدة ويحتفظ به الخادم. لا يُعرض مرة أخرى ولا ترجعه واجهة البرمجة أبدًا.',
    dbUrlRequired: 'رابط قاعدة البيانات مطلوب',
    dbUrlInvalid: 'رابط قاعدة البيانات يجب أن يبدأ بـ libsql:// أو https://',
    dataLocationLabel: 'البيانات', dataLocationFileShort: 'ملف', dataLocationHostedShort: 'Turso',
    tokenSet: 'رمز الدخول محفوظ', tokenNotSet: 'بلا رمز دخول',

    tenantAdopted: 'تم ضمّ متجر قائم',
    tenantAdoptedHeadline: 'قاعدة البيانات هذه كانت تحتوي على متجر بالفعل، فتم ضمّها كما هي تمامًا.',
    tenantAdoptedBody: 'لم تتم أي تهيئة، ولم يتغيّر أي إعداد، ولم تُولّد أي كلمة مرور. كل من كان يستخدم هذا المتجر يسجّل الدخول تمامًا كما كان.',
    adoptedFound: 'الموجود في قاعدة البيانات',

    oneTimePassword: 'كلمة مرور المدير', oneTimePasswordHint: 'تظهر مرة واحدة الآن فقط. لا تُحفظ أبدًا بشكل واضح ولن تظهر مرة أخرى — اكتبها أو انسخها قبل إغلاق هذه النافذة.',
    tenantCreated: 'تم إنشاء المتجر — سلّم كلمة المرور هذه لصاحب المتجر',
    passwordReset: 'تم تغيير كلمة المرور — سلّمها لصاحب المتجر',
    adminAccount: 'حساب المدير', copyToClipboard: 'نسخ', copied: 'تم النسخ',
    copyManually: 'النسخ التلقائي غير متاح هنا — كلمة المرور محددة، اضغط Ctrl+C',
    openErp: 'فتح نظام الـERP', openStorefront: 'فتح المتجر الإلكتروني',

    backToTenants: 'رجوع للمتاجر', tenantDetails: 'تفاصيل المتجر',
    editTenant: 'تعديل البيانات', save: 'حفظ', saved: 'تم الحفظ', cancel: 'إلغاء',
    dangerZone: 'إجراءات حساسة', suspendTenant: 'إيقاف المتجر', resumeTenant: 'استئناف المتجر',
    suspendConfirmTitle: 'إيقاف هذا المتجر؟',
    suspendConfirmBody: 'يتوقف نظام الـERP والمتجر الإلكتروني عن الاستجابة فورًا — كل طلب يرجع "غير متاح مؤقتًا" (HTTP 423) حتى تتم إعادة تشغيله. لا يُحذف أي شيء؛ بيانات المتجر وقاعدة بياناته تبقى كما هي.',
    resumeConfirmTitle: 'استئناف هذا المتجر؟',
    resumeConfirmBody: 'يعود نظام الـERP والمتجر الإلكتروني للعمل فورًا، تمامًا كما كانا قبل الإيقاف.',
    suspended_action: 'تم الإيقاف', resumed_action: 'تم الاستئناف',
    resetAdminPassword: 'إعادة تعيين كلمة مرور المدير',
    resetAdminConfirmTitle: 'إعادة تعيين كلمة مرور المدير؟',
    resetAdminConfirmBody: 'يتم توليد كلمة مرور مؤقتة جديدة لحساب "admin" في هذا المتجر. كلمة المرور القديمة تتوقف عن العمل فورًا.',
    notes: 'ملاحظات', createdAt: 'تاريخ الإنشاء', updatedAt: 'آخر تحديث',
    versionTag: 'الإصدار ١.٠ · إدارة الأسطول',

    migrationsSubtitle: 'تطبيق المخطط والتحديثات على كل متجر مفعّل دفعة واحدة',
    runMigration: 'تشغيل التحديث على كل الأسطول',
    runningMigration: 'جارٍ التشغيل…', migrationHint: 'المتاجر الموقوفة تُتخطى — استأنف المتجر أولًا إذا احتاج التحديث.',
    migrationResults: 'آخر تشغيل', migratedOk: 'تم التحديث', migratedNone: 'لا شيء ليُطبّق', migratedError: 'فشل',
    migrationEmpty: 'شغّل تحديث الأسطول لترى تقريرًا لكل متجر هنا.',
    applied: 'تم تطبيقه', error: 'الخطأ', tenant: 'المتجر', outcome: 'النتيجة',
    migrationSummary: 'تم تحديث {ok} من {total} متجر بنجاح',
    migrationSummaryWithErrors: 'تم تحديث {ok} من {total} متجر بنجاح — وفشل {failed}',
    noneApplied: '— لا جديد —',

    required: 'مطلوب', somethingWrong: 'حدث خطأ ما', close: 'إغلاق', confirm: 'تأكيد', yes: 'نعم',

    // module names — identical wording to the ERP sidebar
    dashboard: 'لوحة التحكم', suppliers: 'الموردون', brands: 'العلامات التجارية', categories: 'الفئات',
    attributes: 'الخصائص', products: 'المنتجات', inventory: 'المخزون', purchases: 'أوامر الشراء',
    customers: 'العملاء', sales: 'المبيعات', promotions: 'العروض والخصومات', reports: 'التقارير',
    users: 'المستخدمون والصلاحيات', audit: 'سجل التدقيق', settings: 'الإعدادات', labels: 'الملصقات',
    weborders: 'طلبات الموقع',
  },
};

// module names for English live in the main block above the Arabic split,
// added here so both languages are defined the same way (one key per module).
Object.assign(dictionary.en, {
  dashboard: 'Dashboard', suppliers: 'Suppliers', brands: 'Brands', categories: 'Categories',
  attributes: 'Attributes', products: 'Products', inventory: 'Inventory', purchases: 'Purchase Orders',
  customers: 'Clients', sales: 'Sales', promotions: 'Promotions', reports: 'Reports',
  users: 'Users & Roles', audit: 'Audit Log', settings: 'Settings', labels: 'Labels',
  weborders: 'Web Orders',
});

let language = localStorage.getItem('mm.platform.lang') || 'en';

export const getLanguage = () => language;
export const isRtl = () => language === 'ar';

export function setLanguage(next) {
  language = next === 'ar' ? 'ar' : 'en';
  localStorage.setItem('mm.platform.lang', language);
  document.documentElement.lang = language;
  document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
}

export function t(key, vars) {
  let text = dictionary[language]?.[key] ?? dictionary.en[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, value);
  }
  return text;
}

/** Choose a tenant's localised name: pickName(row) -> nameAr || nameEn in Arabic. */
export function pickName(row) {
  if (!row) return '';
  return language === 'ar' ? (row.nameAr || row.nameEn) : (row.nameEn || row.nameAr);
}

setLanguage(language);
