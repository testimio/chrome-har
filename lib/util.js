'use strict';
const urlParser = require('url');
const debug = require('debug')('chrome-har');

const isEmpty = o => !o;

module.exports = {
  isHttp1x(version) {
    return version.toLowerCase().startsWith('http/1.');
  },

  formatMillis(time, fractionalDigits = 3) {
    return Number(Number(time).toFixed(fractionalDigits));
  },
  toNameValuePairs(object) {
    return Object.keys(object).reduce((result, name) => {
      const value = object[name];
      if (Array.isArray(value)) {
        return result.concat(
          value.map(v => {
            return { name, value: v };
          })
        );
      } else {
        return result.concat([{ name, value }]);
      }
    }, []);
  },
  parseUrlEncoded(data) {
    const params = urlParser.parse(`?${data}`, true).query;
    return this.toNameValuePairs(params);
  },
  parsePostData(contentType, postData) {
    if (isEmpty(contentType) || isEmpty(postData)) {
      return undefined;
    }

    try {
      if (/^application\/x-www-form-urlencoded/.test(contentType)) {
        return {
          mimeType: contentType,
          params: this.parseUrlEncoded(postData)
        };
      }
      if (/^application\/json/.test(contentType)) {
        return {
          mimeType: contentType,
          params: this.toNameValuePairs(JSON.parse(postData))
        };
      }
      // FIXME parse multipart/form-data as well.
    } catch (e) {
      debug(`Unable to parse post data '${postData}' of type ${contentType}`);
      // Fall back to include postData as text.
    }
    return {
      mimeType: contentType,
      text: postData
    };
  },
  isSupportedProtocol(url) {
    return /^https?:/.test(url);
  },
  blockedResponse() {
    return {
      "status": 0,
      "statusText": "",
      "httpVersion": "",
      "headers": [],
      "cookies": [],
      "content": {
        "size": 0,
        "mimeType": "x-unknown"
      },
      "redirectURL": "",
      "headersSize": -1,
      "bodySize": -1,
      "_transferSize": 0
    }
  },

  blockedTimings() {
    return {
      blocked: -1,
      connect: -1,
      dns: -1,
      receive: -1,
      send: -1,
      ssl: -1,
      wait: -1,
      _queued: -1
    }
  },
  cachedTimings(willBeSent,loadingFinished) {
    return {
        "blocked": -1,
        "dns": -1,
        "ssl": -1,
        "connect": -1,
        "send": 0,
        "wait": 0.01,
        "receive": module.exports.formatMillis(loadingFinished-willBeSent) * 1000,
        "_blocked_queueing": -1
      }
  }
};
