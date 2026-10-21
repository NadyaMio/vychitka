'use strict';

/**
 * Per-paragraph analysis context shared by all checkers: tokens, sentences,
 * quote/speech spans and small lookup helpers over tokens.
 */

const { analyze, quoteSpans, speechSpans, inSpans, prevIndex, nextIndex } = require('./tokenize');
const morph = require('./morph');

/**
 * Build the context for one paragraph.
 * @param {string} text
 * @param {number} para
 * @param {object} settings merged settings
 * @param {object} env { rules }
 * @returns {object}
 */
function buildContext(text, para, settings, env) {
  const { tokens, sentences } = analyze(text);
  const starts = tokens.map((t) => t.start);
  const quotes = quoteSpans(text);
  const speech = speechSpans(text);
  const skipSpans = settings.skipQuotes ? quotes.concat(speech) : [];

  /** Index of the token that covers position `pos` (or starts at it), or -1. */
  function tokenAt(pos) {
    let lo = 0;
    let hi = starts.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= pos) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (ans >= 0 && pos < tokens[ans].end) return ans;
    return -1;
  }

  /** First non-space token starting at or after `pos`, or null. */
  function nextTokenFrom(pos) {
    let lo = 0;
    let hi = starts.length - 1;
    let ans = starts.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] >= pos) {
        ans = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    for (let k = ans; k < tokens.length; k++) if (tokens[k].type !== 'space') return tokens[k];
    return null;
  }

  /** Next word-type token after position `pos` (skipping spaces only), or null. */
  function nextWordFrom(pos) {
    const t = nextTokenFrom(pos);
    return t && t.type === 'word' ? t : null;
  }

  /** Last non-space token ending at or before `pos`, or null. */
  function prevTokenBefore(pos) {
    const i = tokenAt(pos - 1);
    let k = i === -1 ? tokens.length - 1 : i;
    for (; k >= 0; k--) {
      const t = tokens[k];
      if (t.end > pos) continue;
      if (t.type !== 'space') return t;
    }
    return null;
  }

  function prevWordBefore(pos) {
    const t = prevTokenBefore(pos);
    return t && t.type === 'word' ? t : null;
  }

  /** Word tokens of the sentence containing token index i. */
  function sentenceOf(i) {
    return sentences[tokens[i].si] || null;
  }

  function isSentenceStart(i) {
    const s = sentenceOf(i);
    return !!s && s.words.length > 0 && s.words[0] === i;
  }

  function inSkip(start, end) {
    return skipSpans.length > 0 && inSpans(skipSpans, start, end);
  }

  return {
    para,
    text,
    settings,
    rules: env.rules,
    tokens,
    sentences,
    quotes,
    speech,
    tokenAt,
    nextTokenFrom,
    nextWordFrom,
    prevTokenBefore,
    prevWordBefore,
    sentenceOf,
    isSentenceStart,
    inSkip,
    prevIndex: (i) => prevIndex(tokens, i),
    nextIndex: (i) => nextIndex(tokens, i),
    morph,
  };
}

module.exports = { buildContext };
