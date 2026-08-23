/**
 * Strings for the backup screens, in the same shape as `i18n.detail.js` and
 * merged the same way — a key here never overwrites one already defined.
 *
 * Two rules carried over from that file, for the same reasons:
 *
 *   - Arabic is written, not translated. The person reading a restore dialog at
 *     one in the morning is reading Arabic, and a sentence assembled by a
 *     dictionary is the wrong thing to hand somebody about to overwrite a live
 *     shop. Where a word has no natural Arabic ("snapshot"), the Arabic says
 *     what the thing DOES rather than borrowing the English.
 *   - Numerals stay Latin in both languages, as `format.js` decided for the
 *     whole console.
 */
export const backupStrings = {
  en: {
    tabBackups: 'Backups',
    backupsTitle: 'Backups',
    backupsSubtitle: 'One file per backup: spreadsheets you can open, and a snapshot this shop can be put back from',
    takeBackup: 'Back up now',
    takingBackup: 'Backing up…',
    backupTaken: 'Backup taken',
    noBackupsTitle: 'This shop has never been backed up',
    noBackupsBody: 'Take one now, or wait for the nightly run. Nothing about this shop is lost until then — but nothing is kept either.',

    backupWhen: 'Taken', backupKind: 'How', backupSize: 'Size', backupRows: 'Rows',
    backupState: 'State',
    kindScheduled: 'Nightly', kindManual: 'By hand', kindPreRestore: 'Before a restore',
    stateReady: 'Ready', stateFailed: 'Failed', stateRunning: 'Unfinished',
    backupFailedHint: 'This backup did not finish. Nothing was stored — the row is kept so the failure is visible.',
    backupTruncated: 'Some spreadsheet tabs stopped at their row limit. The snapshot beside them is complete.',

    download: 'Download', preparingDownload: 'Preparing…',
    downloadStarted: 'The download has started',
    downloadWhatTitle: 'What is in this file',
    downloadWhatBody: 'Two Excel workbooks (Arabic and English) with products, stock, clients, sales, purchases, costs, employees and users — and a complete snapshot this shop can be restored from.',
    downloadCareTitle: 'This is the shop\'s entire book',
    downloadCareBody: 'Every price, every cost, every client\'s phone number, and what every employee is paid. Anyone who opens this file has all of it.',

    // ── restore ────────────────────────────────────────────────────────────
    restore: 'Restore',
    restoreTitle: 'Restore this shop from {when}?',
    restoreLead: 'This replaces everything in "{slug}" with what was in it when this backup was taken. Anything the shop has done since is lost.',
    restoreStepsTitle: 'What happens, in order',
    restoreStep1: 'The shop is suspended — the till and the storefront stop answering.',
    restoreStep2: 'A safety copy of the shop AS IT IS NOW is taken first, so this can itself be undone.',
    restoreStep3: 'The whole shop is replaced in one transaction: it either happens or nothing changes.',
    restoreStep4: 'The shop starts trading again — but only if the restore worked. If it did not, it stays suspended and tells you.',
    restoreCompare: 'What changes',
    restoreNow: 'Now', restoreAfter: 'After',
    restoreTypeSlug: 'Type the shop\'s short name to confirm which shop is being overwritten',
    restoreSlugMismatch: 'That is not this shop\'s short name',
    restoreConfirm: 'Overwrite this shop',
    restoreRunning: 'Restoring — do not close this page…',
    restoreDone: 'Restored: {rows} rows across {tables} tables',
    restoreSafety: 'A safety copy was taken first — it is the top row of this list.',
    checkPlan: 'Check what this would do',
    planning: 'Checking…',

    // ── the fleet ──────────────────────────────────────────────────────────
    backupsColumn: 'Backup',
    backupNever: 'Never',
    backupHoursAgo: '{n}h ago',
    backupDaysAgo: '{n}d ago',
    backupOverdue: 'Overdue',
    backupsNotArmedTitle: 'Automatic backups are not switched on',
    backupsNotArmedBody: 'This deployment has no CRON_SECRET, so the nightly job refuses to run. Add it to the project\'s environment variables and redeploy. Until then, only backups taken by hand exist.',
    backupsOverdueTitle: '{n} shop(s) have not been backed up recently',
    backupsOverdueBody: 'Nothing older than {hours} hours should be on this list. Open a shop and take one by hand, or check why the nightly job is not reaching it.',
    backupsStored: 'Stored', backupsKept: 'Kept',
    backupCeiling: 'Largest a backup may be',
    backupCeilingHint: 'A shop bigger than this is refused rather than half-copied — and the refusal is shown here in red.',
    keepRule: '{scheduled} nightly · {manual} by hand · {pre_restore} before a restore',
  },

  ar: {
    tabBackups: 'النسخ الاحتياطية',
    backupsTitle: 'النسخ الاحتياطية',
    backupsSubtitle: 'ملف واحد لكل نسخة: جداول تقدر تفتحها، ونسخة كاملة يترجع منها المتجر لو حصل حاجة',
    takeBackup: 'خُد نسخة دلوقتي',
    takingBackup: 'جارٍ أخذ النسخة…',
    backupTaken: 'تم أخذ النسخة',
    noBackupsTitle: 'المتجر ده لسه ما اتاخدلوش نسخة احتياطية',
    noBackupsBody: 'خُد واحدة دلوقتي، أو استنى النسخة الليلية. مفيش حاجة ضاعت لحد دلوقتي — بس مفيش حاجة محفوظة كمان.',

    backupWhen: 'التاريخ', backupKind: 'النوع', backupSize: 'الحجم', backupRows: 'عدد الصفوف',
    backupState: 'الحالة',
    kindScheduled: 'ليلية', kindManual: 'يدوية', kindPreRestore: 'قبل استرجاع',
    stateReady: 'جاهزة', stateFailed: 'فشلت', stateRunning: 'لم تكتمل',
    backupFailedHint: 'النسخة دي ما اكتملتش. مفيش أي بيانات اتخزنت — السطر متسجّل عشان الفشل يبان مش يختفي.',
    backupTruncated: 'بعض صفحات الجداول وقفت عند الحد الأقصى للصفوف. النسخة الكاملة اللي جنبها فيها كل شيء.',

    download: 'تنزيل', preparingDownload: 'جارٍ التجهيز…',
    downloadStarted: 'بدأ التنزيل',
    downloadWhatTitle: 'إيه اللي جوه الملف ده',
    downloadWhatBody: 'ملفّا Excel (عربي وإنجليزي) فيهم المنتجات والمخزون والعملاء والمبيعات والمشتريات والتكاليف والموظفين والمستخدمين — ونسخة كاملة يقدر المتجر يرجع منها.',
    downloadCareTitle: 'ده دفتر المتجر كامل',
    downloadCareBody: 'كل سعر، وكل تكلفة، ورقم تليفون كل عميل، ومرتّب كل موظف. أي حد يفتح الملف ده يبقى معاه كل ده.',

    restore: 'استرجاع',
    restoreTitle: 'ترجّع المتجر لحالة {when}؟',
    restoreLead: 'ده هيستبدل كل اللي في "{slug}" باللي كان فيه وقت أخذ النسخة دي. أي حاجة اتعملت في المتجر بعد كده هتضيع.',
    restoreStepsTitle: 'اللي هيحصل، بالترتيب',
    restoreStep1: 'المتجر هيتوقف — الكاشير والمتجر الإلكتروني هيبطّلوا يستجيبوا.',
    restoreStep2: 'هتتاخد نسخة أمان من المتجر بحالته الحالية الأول، عشان الخطوة دي نفسها تبقى قابلة للتراجع.',
    restoreStep3: 'المتجر كله هيتستبدل في عملية واحدة: يا يتم بالكامل يا ما يتغيّر أي شيء.',
    restoreStep4: 'المتجر هيرجع يشتغل — بس لو الاسترجاع نجح. لو فشل هيفضل موقوف وهيقولك.',
    restoreCompare: 'اللي هيتغيّر',
    restoreNow: 'دلوقتي', restoreAfter: 'بعد الاسترجاع',
    restoreTypeSlug: 'اكتب الاسم المختصر للمتجر عشان تأكد إنك بتستبدل المتجر ده بالذات',
    restoreSlugMismatch: 'ده مش الاسم المختصر بتاع المتجر ده',
    restoreConfirm: 'استبدل بيانات المتجر',
    restoreRunning: 'جارٍ الاسترجاع — ما تقفلش الصفحة…',
    restoreDone: 'تم الاسترجاع: {rows} صف في {tables} جدول',
    restoreSafety: 'اتاخدت نسخة أمان الأول — هي أول سطر في القائمة دي.',
    checkPlan: 'شوف ده هيعمل إيه',
    planning: 'جارٍ الفحص…',

    backupsColumn: 'آخر نسخة',
    backupNever: 'أبدًا',
    backupHoursAgo: 'من {n} ساعة',
    backupDaysAgo: 'من {n} يوم',
    backupOverdue: 'متأخرة',
    backupsNotArmedTitle: 'النسخ الاحتياطية التلقائية مش مفعّلة',
    backupsNotArmedBody: 'النشر ده مافيهوش CRON_SECRET، فالمهمة الليلية بترفض تشتغل. ضيفه في إعدادات المشروع وأعد النشر. لحد ساعتها مفيش غير النسخ اليدوية.',
    backupsOverdueTitle: '{n} متجر ماخدوش نسخة احتياطية من فترة',
    backupsOverdueBody: 'المفروض مافيش حاجة أقدم من {hours} ساعة تبقى في القائمة دي. افتح المتجر وخُد نسخة يدوي، أو شوف ليه المهمة الليلية مش واصلاله.',
    backupsStored: 'المحفوظ', backupsKept: 'المحتفظ به',
    backupCeiling: 'الحد الأقصى للنسخة',
    backupCeilingHint: 'المتجر الأكبر من كده بتترفض نسخته بدل ما تتاخد ناقصة — والرفض بيبان هنا بالأحمر.',
    keepRule: '{scheduled} ليلية · {manual} يدوية · {pre_restore} قبل الاسترجاع',
  },
};

export default backupStrings;
