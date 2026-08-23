/**
 * The words the overview needs now that its figures are read rather than
 * computed — how old they are, who wrote them last, and what to say about a
 * shop nobody has measured.
 *
 * Its own file for the same reason the backups and landing dictionaries are:
 * a screen that brings its own strings can be added without touching the main
 * dictionary, and `core/i18n.js` merges these without ever overwriting a key
 * that already exists there.
 *
 * The Arabic is written the way the console's Arabic already reads — plain,
 * shop-owner Arabic rather than translated software English — and every string
 * that carries a number keeps the number in a placeholder so the sentence can
 * be ordered the way each language orders it.
 */
export const fleetStrings = {
  en: {
    // ── How old the figures are ──────────────────────────────────────────
    figuresAsOf: 'Figures read {ago}',
    figuresReadAt: 'Figures read {ago} · the shops themselves were not opened',
    figuresLive: 'Read from every shop just now',
    measuredCount: '{measured} of {total} shops measured',
    refreshNow: 'Refresh now',
    refreshingFleet: 'Reading every shop…',
    refreshedFleet: '{ok} shop(s) refreshed',
    refreshedFleetWithErrors: '{ok} shop(s) refreshed, {failed} could not be read',
    lastRead: 'Last read',
    notMeasured: 'Not measured yet',
    notMeasuredShort: 'not measured',
    notMeasuredHint: 'Nobody has read this shop yet. It will be read on the next sweep, or press "Refresh now".',
    staleTag: 'Stale',
    staleTitle: 'Some figures are out of date.',
    staleHint: 'These shops were last read more than {hours} hours ago, so what you see below is what was true then:',
    neverMeasuredTitle: 'Some shops have never been measured.',
    neverMeasuredHint: 'Their rows show dashes rather than zeros — nobody has read them yet:',
    summarySource: 'Written by',
    sourceCron: 'the scheduled sweep',
    sourceRequest: 'the shop itself',
    sourceConsole: 'this console',
    sourceBackfill: 'this page',
    sweepOffTitle: 'Nothing is refreshing these figures automatically.',
    sweepOffHint: 'This deployment has no CRON_SECRET, so the scheduled sweep never runs — and neither do the automatic backups, which the same secret switches on. '
      + 'Add it to the project\'s environment variables and redeploy, or press "Refresh now" when you need current numbers.',
    todayFromShops: 'from {shops} of {total} shops read today',
    todayUnknown: 'not read today',
    liveDecisions: 'Shop count, status and website are live',
    unreachableSince: 'Could not be read {ago}',
    lastGoodFigures: 'The figures below are the last that could be read.',
  },

  ar: {
    figuresAsOf: 'قُرئت الأرقام {ago}',
    figuresReadAt: 'قُرئت الأرقام {ago} · لم تُفتح قواعد بيانات المتاجر',
    figuresLive: 'قُرئت من كل متجر الآن',
    measuredCount: 'تمت قراءة {measured} من {total} متجر',
    refreshNow: 'حدّث الآن',
    refreshingFleet: 'جاري قراءة كل متجر…',
    refreshedFleet: 'تم تحديث {ok} متجر',
    refreshedFleetWithErrors: 'تم تحديث {ok} متجر، وتعذّرت قراءة {failed}',
    lastRead: 'آخر قراءة',
    notMeasured: 'لم تُقرأ بعد',
    notMeasuredShort: 'لم تُقرأ',
    notMeasuredHint: 'لم يقرأ أحد هذا المتجر بعد. سيُقرأ في الجولة القادمة، أو اضغط «حدّث الآن».',
    staleTag: 'قديمة',
    staleTitle: 'بعض الأرقام قديمة.',
    staleHint: 'هذه المتاجر آخر قراءة لها كانت قبل أكثر من {hours} ساعة، فما تراه بالأسفل هو ما كان صحيحًا وقتها:',
    neverMeasuredTitle: 'بعض المتاجر لم تُقرأ ولا مرة.',
    neverMeasuredHint: 'صفوفها تعرض شرطات بدلًا من أصفار — لم يقرأها أحد بعد:',
    summarySource: 'كتبها',
    sourceCron: 'الجولة المجدولة',
    sourceRequest: 'المتجر نفسه',
    sourceConsole: 'هذه اللوحة',
    sourceBackfill: 'هذه الشاشة',
    sweepOffTitle: 'لا شيء يحدّث هذه الأرقام تلقائيًا.',
    sweepOffHint: 'هذا النشر ليس فيه CRON_SECRET، فالجولة المجدولة لا تعمل أبدًا — ولا النسخ الاحتياطية التلقائية، لأن نفس المفتاح هو اللي بيشغّلها. '
      + 'أضِفه إلى متغيرات البيئة في المشروع وأعد النشر، أو اضغط «حدّث الآن» وقت ما تحتاج أرقامًا حالية.',
    todayFromShops: 'من {shops} من {total} متجر قُرئت اليوم',
    todayUnknown: 'لم تُقرأ اليوم',
    liveDecisions: 'عدد المتاجر وحالتها والموقع الإلكتروني تُقرأ مباشرة',
    unreachableSince: 'تعذّرت قراءته {ago}',
    lastGoodFigures: 'الأرقام بالأسفل هي آخر ما أمكن قراءته.',
  },
};

export default fleetStrings;
