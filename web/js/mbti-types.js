/**
 * MBTI 16 型基础数据 —— 前后端共用。
 *
 * 事实来源：
 *  - 代码 / 英文名 / 官方中文译名：逐个抓取 www.16personalities.com 页面 title 核实
 *    （中文路径 https://www.16personalities.com/ch/{code}-人格）
 *  - 四组主题色：抓自官方 build/assets/styles-core.css 的 CSS 变量
 *    --color-purple/blue/green/yellow
 *  - 描述文案为原创撰写，非官方 copy
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MBTI = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 四大人格组（16personalities 官方分组） */
  var GROUPS = {
    NT: { key: 'NT', cn: '分析家', en: 'Analysts', color: '#88619A', rgb: '136,97,154' },
    NF: { key: 'NF', cn: '外交家', en: 'Diplomats', color: '#33A474', rgb: '51,164,116' },
    SJ: { key: 'SJ', cn: '守护者', en: 'Sentinels', color: '#4298B4', rgb: '66,152,180' },
    SP: { key: 'SP', cn: '探险家', en: 'Explorers', color: '#E4AE3A', rgb: '228,174,58' }
  };

  /**
   * 16 型，按 4×4 网格的自然顺序排列（每组一行）：
   *   第 1 行 分析家 NT    第 2 行 外交家 NF
   *   第 3 行 守护者 SJ    第 4 行 探险家 SP
   */
  var TYPES = [
    { code: 'INTJ', cn: '架构师', en: 'Architect', slug: 'architect', group: 'NT',
      tagline: '先想清楚全局，再动手，且绝不半途而废' },
    { code: 'INTP', cn: '逻辑学家', en: 'Logician', slug: 'logician', group: 'NT',
      tagline: '对世界如何运转有停不下来的好奇' },
    { code: 'ENTJ', cn: '指挥官', en: 'Commander', slug: 'commander', group: 'NT',
      tagline: '目标一旦定下，就会把人和资源都推到位' },
    { code: 'ENTP', cn: '辩论家', en: 'Debater', slug: 'debater', group: 'NT',
      tagline: '喜欢把任何结论都掀开看看反面' },

    { code: 'INFJ', cn: '提倡者', en: 'Advocate', slug: 'advocate', group: 'NF',
      tagline: '安静地看透人心，然后默默做点有意义的事' },
    { code: 'INFP', cn: '调停者', en: 'Mediator', slug: 'mediator', group: 'NF',
      tagline: '心里有一套自己的价值标准，不轻易妥协' },
    { code: 'ENFJ', cn: '主人公', en: 'Protagonist', slug: 'protagonist', group: 'NF',
      tagline: '天生会让一群人相信他们能做到' },
    { code: 'ENFP', cn: '活动家', en: 'Campaigner', slug: 'campaigner', group: 'NF',
      tagline: '热情来得快，兴趣换得也快，但从不无聊' },

    { code: 'ISTJ', cn: '物流师', en: 'Logistician', slug: 'logistician', group: 'SJ',
      tagline: '说到做到，交给他就不用再操心' },
    { code: 'ISFJ', cn: '守护者', en: 'Defender', slug: 'defender', group: 'SJ',
      tagline: '记得所有人的小事，很少声张' },
    { code: 'ESTJ', cn: '管理者', en: 'Executive', slug: 'executive', group: 'SJ',
      tagline: '把混乱的事情理顺，是他最舒服的状态' },
    { code: 'ESFJ', cn: '执政官', en: 'Consul', slug: 'consul', group: 'SJ',
      tagline: '让身边每个人都觉得自己被在乎' },

    { code: 'ISTP', cn: '鉴赏家', en: 'Virtuoso', slug: 'virtuoso', group: 'SP',
      tagline: '话不多，但东西坏了找他准没错' },
    { code: 'ISFP', cn: '冒险家', en: 'Adventurer', slug: 'adventurer', group: 'SP',
      tagline: '不争不抢，却有自己的审美和底线' },
    { code: 'ESTP', cn: '企业家', en: 'Entrepreneur', slug: 'entrepreneur', group: 'SP',
      tagline: '先做了再说，在行动里找答案' },
    { code: 'ESFP', cn: '表演者', en: 'Entertainer', slug: 'entertainer', group: 'SP',
      tagline: '走到哪里都能把气氛带起来' }
  ];

  /**
   * 四个维度。
   * vote 流程中每个维度是一个「左右二选一」的量表题：
   * 点击左半侧选 left，右半侧选 right。
   */
  var AXES = [
    { key: 'IE', left: 'I', right: 'E', leftCn: '内向', rightCn: '外向',
      leftDesc: '更愿意独处，从内部世界获得能量', rightDesc: '更愿意社交，从外部世界获得能量' },
    { key: 'NS', left: 'N', right: 'S', leftCn: '直觉', rightCn: '实感',
      leftDesc: '关注可能性与未来的联系', rightDesc: '关注事实与当下的细节' },
    { key: 'TF', left: 'T', right: 'F', leftCn: '思考', rightCn: '情感',
      leftDesc: '依据逻辑与客观标准做判断', rightDesc: '依据价值与人的感受做判断' },
    { key: 'PJ', left: 'P', right: 'J', leftCn: '感知', rightCn: '判断',
      leftDesc: '保持开放，随机应变', rightDesc: '倾向计划，按部就班' }
  ];

  /** code -> type 对象 */
  var BY_CODE = {};
  TYPES.forEach(function (t) {
    t.color = GROUPS[t.group].color;
    BY_CODE[t.code] = t;
  });

  /** 判断字符串是否是合法的 MBTI 代码 */
  function isValidCode(code) {
    return Object.prototype.hasOwnProperty.call(BY_CODE, String(code || '').toUpperCase());
  }

  /**
   * 由四个轴的选择拼出 MBTI 代码。
   * @param {{IE?:string,NS?:string,TF?:string,PJ?:string}} axes
   * @returns {string|null} 例如 'INTJ'；任一轴缺失则返回 null
   */
  function buildCode(axes) {
    if (!axes) return null;
    var out = '';
    for (var i = 0; i < AXES.length; i++) {
      var v = axes[AXES[i].key];
      if (v !== AXES[i].left && v !== AXES[i].right) return null;
      out += v;
    }
    return out;
  }

  /** 取类型对象；非法代码返回 null */
  function get(code) {
    return BY_CODE[String(code || '').toUpperCase()] || null;
  }

  return {
    GROUPS: GROUPS,
    TYPES: TYPES,
    AXES: AXES,
    BY_CODE: BY_CODE,
    isValidCode: isValidCode,
    buildCode: buildCode,
    get: get
  };
});
