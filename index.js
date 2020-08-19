'use strict';
const urlParser = require('url');
const uuid = require('uuid/v1');
const dayjs = require('dayjs');
const debug = require('debug')('chrome-har');
const ignoredEvents = require('./lib/ignoredEvents');
const { parseRequestCookies, parseResponseCookies, formatCookie } = require('./lib/cookies');
const { getHeaderValue, parseHeaders } = require('./lib/headers');
const {
  isHttp1x,
  formatMillis,
  parsePostData,
  isSupportedProtocol,
  toNameValuePairs,
  blockedResponse,
  blockedTimings,
  cachedTimings
} = require('./lib/util');
const {
  createSyntheticEventFromFrameNavigated,
  createSyntheticEventFromResponse
} = require('./lib/syntheticEventsCreator')
const populateEntryFromResponse = require('./lib/entryFromResponse');

const defaultOptions = {
  includeResourcesFromDiskCache: false,
  includeTextFromResponseBody: false,
  includeCustomProperties: false,
  name: 'Testim',
  version: '1.0',
  comment: 'Created during a test executed by Testim.',
  meta: undefined,
  wallTimeHelper: {
    getWallTimeFromTimestamp(timestamp) {
      return undefined;
    },
    getTimestampFromWallTime(wallTime) {
      return undefined;
    }
  }
};
const isEmpty = o => !o;

const max = Math.max;

function addFromFirstRequest(page, params) {
  if (!page.__timestamp) {
    page.__wallTime = params.wallTime;
    page.__timestamp = params.timestamp;
    page.startedDateTime = dayjs.unix(params.wallTime).toISOString(); //epoch float64, eg 1440589909.59248
    // URL is better than blank, and it's what devtools uses.
    page.title = page.title === '' ? params.request.url : page.title;
  }

  if (!page.__loaderId && params.loaderId) {
    page.__loaderId = params.loaderId;
  }
}

function addFromFirstResponse(page, params, wallTimeHelper) {
  const { response, loaderId } = params;
  if (!page.__timestamp) {
    page.__timestamp = response.timing.requestTime;
  }

  const wallTime = wallTimeHelper.getWallTimeFromTimestamp(response.timing.requestTime);
  if (wallTime) {
    page.__wallTime = wallTime;
    page.startedDateTime = dayjs.unix(wallTime).toISOString(); //epoch float64, eg 1440589909.59248
  }
  // URL is better than blank, and it's what devtools uses.
  page.title = response.url;

  if (!page.__loaderId && loaderId) {
    page.__loaderId = loaderId;
  }
}


function attachCustomProps(entry, params,) {
  const custom = params['_custom'];
  if (custom) {
    entry._testim = Object.assign(entry._testim || {}, custom);
  }
}



module.exports = {
  harFromMessages(messages, options) {
    options = Object.assign({}, defaultOptions, options);
    const ignoredRequests = new Set(),
      rootFrameMappings = new Map(),
      loaders = new Map(),
      responseExtraInfo = new Map(),
      requestExtraInfo = new Map(),
      recognizedOptionsCalls = new Map();

    let pages = [],
      entries = [],
      entriesWithoutPage = [],
      responsesWithoutPage = [],
      paramsWithoutPage = [],
      currentPageId;

    function attachPagelessRequests(page) {
      // do we have any unmmapped requests, add them
      if (entriesWithoutPage.length > 0) {
        // update page
        for (let entry of entriesWithoutPage) {
          entry.pageref = page.id;
        }
        entries = entries.concat(entriesWithoutPage);
        addFromFirstRequest(page, paramsWithoutPage[0]);
        entriesWithoutPage = [];
        paramsWithoutPage = [];
      }
      if (responsesWithoutPage.length > 0) {
        for (let params of responsesWithoutPage) {
          let entry = entries.find(
            entry => entry._requestId === params.requestId
          );
          if (entry) {
            populateEntryFromResponse(
              entry,
              params.response,
              options
            );
          } else {
            debug(`Couldn't find matching request for response`);
          }
        }
        responsesWithoutPage = [];
      }
    }
    
    for (let currentPosition = 0; currentPosition < messages.length; currentPosition++) {
      const message = messages[currentPosition];  
      const params = message.params;
      const method = message.method;      

      if (!/^(Page|Network)\..+/.test(method)) {
        continue;
      }

      switch (method) {
        case 'Page.frameNavigated': {
          // not the root
          if (params.frame.parentId) {
            continue;
          }

          // already seen this navigation
          if (pages.some(page => page.__loaderId === params.frame.loaderId)) {
            continue;
          }

          const prevRoot = pages.find(page => page.__frameId === undefined);
          if (prevRoot && prevRoot.loaderId) {
            prevRoot.__frameId = "removed";
          }

          currentPageId = uuid();
          const page = {
            id: currentPageId,
            startedDateTime: '',
            title: params.frame.url,
            pageTimings: {},
            __loaderId: params.frame.loaderId,
            __frameId: params.frame.id,
          };
          const firstRequest = loaders.get(params.frame.loaderId);
          if (firstRequest) {
            addFromFirstRequest(page, firstRequest);
          } else {
            // try to create a synthetic event.
            // this use-case usually happens when the debugger
            // is attached after the page request was sent, but before
            // the response was received. We assume that
            // the page is request is one of the first 10 messages.
            const responseInfo = messages.slice(0, 10)
              .find(x => x.method === 'Network.responseReceived' && x.params.requestId === params.frame.loaderId);

            if (responseInfo) {
              const responseParams = responseInfo.params;
              addFromFirstResponse(page, responseParams, options.wallTimeHelper);
              const entry = createSyntheticEventFromResponse(page, responseParams);
              if (options.includeCustomProperties) {
                attachCustomProps(entry, responseParams);
              }
              entries.push(entry);
            } else {
              // totally without a request, do something.
              const entry = createSyntheticEventFromFrameNavigated(page, params)
              entries.push(entry);
            }
          }
          pages.push(page);
          attachPagelessRequests(page);
          continue;
        }
        case 'Page.navigatedWithinDocument':
          {
            const frameId = params.frameId;
            const rootFrame = rootFrameMappings.get(frameId) || frameId;
            if (pages.some(page => page.__frameId === rootFrame)) {
              continue;
            }

            currentPageId = uuid();
            const title =
              method === 'Page.navigatedWithinDocument' ? params.url : '';
            const page = {
              id: currentPageId,
              startedDateTime: '',
              title: title,
              pageTimings: {},
              __frameId: rootFrame
            };
            pages.push(page);
            attachPagelessRequests(page);
          }
          break;

        case 'Network.requestWillBeSent':
          {
            const request = params.request;
            if (!isSupportedProtocol(request.url)) {
              ignoredRequests.add(params.requestId);
              continue;
            }

            // OPTIONS calls have their own loader/initiator. However, this was created by a previous request
            // try to find that request in the 10 previous events
            if (params.loaderId === '' && params.request.method === 'OPTIONS' && params.initiator.type === 'other') {                
                // hueristically, look in the last 10 calls in reverse order (i.e. prefer the latest).
                const latest = messages.slice(currentPosition - 50, currentPosition).reverse();
                const initiator = latest.find(x=> x.method === 'Network.requestWillBeSent' 
                                                    && x.params.request.method !== 'OPTIONS' 
                                                    && x.params.request.url === params.documentURL);
                if (initiator) {
                    params.loaderId = initiator.params.loaderId;
                    params.frameId = initiator.params.frameId;
                    // save for next events
                    recognizedOptionsCalls.set(params.requestId, { loaderId: params.loaderId, frameId: params.frameId });
                }
            }

            // could not find loader for page
            if (!loaders.has(params.loaderId)) {            
                loaders.set(params.loaderId, params);
            }
            const page = pages[pages.length - 1];
            const cookieHeader = getHeaderValue(request.headers, 'Cookie');

            //Before we used to remove the hash fragment because of Chrome do that but:
            // 1. Firefox do not
            // 2. If we remove it, the HAR will not have the same URL as we tested
            // and that makes PageXray generate the wromng URL and we end up with two pages
            // in sitespeed.io if we run in SPA mode
            const url = urlParser.parse(
              request.url + (request.urlFragment ? request.urlFragment : ''),
              true
            );

            const postData = parsePostData(
              getHeaderValue(request.headers, 'Content-Type'),
              request.postData
            );

            const req = {
              method: request.method,
              url: urlParser.format(url),
              queryString: toNameValuePairs(url.query),
              postData,
              headersSize: -1,
              bodySize: isEmpty(request.postData) ? 0 : request.postData.length,
              cookies: parseRequestCookies(cookieHeader),
              headers: parseHeaders(request.headers)
            };

            if (requestExtraInfo.has(request.requestId)) {
              addRequestExtraInfo(request, requestExtraInfo.get(request.requestId).headers);
            }

            const entry = {
              cache: {},
              startedDateTime: '',
              __requestWillBeSentTime: params.timestamp,
              __wallTime: params.wallTime,
              _requestId: params.requestId,
              __frameId: params.frameId,
              _initialPriority: request.initialPriority,
              _priority: request.initialPriority,
              pageref: currentPageId,
              request: req,
              time: 0,
              _initiator_detail: JSON.stringify(params.initiator),
              _initiator_type: params.initiator.type
            };
            if(typeof params.type === 'string') {
              entry._resourceType = params.type.toLowerCase();
            }
            if (options.includeCustomProperties) {
              attachCustomProps(entry, params);
            }
            // The object initiator change according to its type
            switch (params.initiator.type) {
              case 'parser':
                {
                  entry._initiator = params.initiator.url;
                  entry._initiator_line = params.initiator.lineNumber + 1; // Because lineNumber is 0 based
                }
                break;

              case 'script':
                {
                  if (
                    params.initiator.stack &&
                    params.initiator.stack.callFrames.length > 0
                  ) {
                    const topCallFrame = params.initiator.stack.callFrames[0];
                    entry._initiator = topCallFrame.url;
                    entry._initiator_line = topCallFrame.lineNumber + 1; // Because lineNumber is 0 based
                    entry._initiator_column = topCallFrame.columnNumber + 1; // Because columnNumber is 0 based
                    entry._initiator_function_name = topCallFrame.functionName;
                    entry._initiator_script_id = topCallFrame.scriptId;
                  }
                }
                break;
            }

            if (params.redirectResponse) {
              const previousEntry = entries.find(
                entry => entry._requestId === params.requestId
              );
              if (previousEntry) {
                previousEntry._requestId += 'r';
                populateEntryFromResponse(
                  previousEntry,
                  params.redirectResponse,
                  options
                );
              } else {
                debug(
                  `Couldn't find original request for redirect response: ${
                  params.requestId
                  }`
                );
              }
            }

            if (!page) {
              debug(
                `Request will be sent with requestId ${
                params.requestId
                } that can't be mapped to any page at the moment.`
              );
              // ignoredRequests.add(params.requestId);
              entriesWithoutPage.push(entry);
              paramsWithoutPage.push(params);
              continue;
            }

            entries.push(entry);

            // this is the first request for this page, so set timestamp of page.
            addFromFirstRequest(page, params);
            // wallTime is not necessarily monotonic, timestamp is. So calculate startedDateTime from timestamp diffs.
            // (see https://cs.chromium.org/chromium/src/third_party/WebKit/Source/platform/network/ResourceLoadTiming.h?q=requestTime+package:%5Echromium$&dr=CSs&l=84)
            const entrySecs = page.__wallTime + (params.timestamp - page.__timestamp);
            entry.startedDateTime = dayjs.unix(entrySecs).toISOString();
          }
          break;

        case 'Network.requestServedFromCache':
          {
            if (pages.length < 1) {
              //we haven't loaded any pages yet.
              continue;
            }

            if (ignoredRequests.has(params.requestId)) {
              continue;
            }

            const entry = entries.find(
              entry => entry._requestId === params.requestId
            );
            if (!entry) {
              debug(
                `Received requestServedFromCache for requestId ${
                params.requestId
                } with no matching request.`
              );
              continue;
            }

            entry.__servedFromCache = true;
            entry.cache.beforeRequest = {
              lastAccess: '',
              eTag: '',
              hitCount: 0
            };
          }
          break;

        case 'Network.responseReceived':
          {
            if (pages.length < 1) {
              //we haven't loaded any pages yet.
              responsesWithoutPage.push(params);
              continue;
            }

            if (ignoredRequests.has(params.requestId)) {
              continue;
            }

            let entry = entries.find(
              entry => entry._requestId === params.requestId
            );

            if (!entry) {
              entry = entriesWithoutPage.find(
                entry => entry._requestId === params.requestId
              );
            }
            if (!entry) {
              debug(
                `Received network response for requestId ${
                params.requestId
                } with no matching request.`
              );
              continue;

            }
            if (options.includeCustomProperties) {
              attachCustomProps(entry, params);
            }
            const frameId =
              rootFrameMappings.get(params.frameId) || params.frameId || (recognizedOptionsCalls.get(params.requestId) || {}).frameId;
            const page = pages.find(page => page.__frameId === frameId);
            if (!page) {
              debug(
                `Received network response for requestId ${
                params.requestId
                } that can't be mapped to any page.`
              );
              continue;
            }

            try {
              populateEntryFromResponse(entry, params.response, options);
              if (responseExtraInfo.has(params.requestId)) {
                addResponseExtraInfo(entry.response, responseExtraInfo.get(params.requestId));
              }
            } catch (e) {
              debug(
                `Error parsing response: ${JSON.stringify(
                  params,
                  undefined,
                  2
                )}`
              );
              throw e;
            }
          }
          break;

        case 'Network.dataReceived':
          {
            if (pages.length < 1) {
              //we haven't loaded any pages yet.
              continue;
            }
            if (ignoredRequests.has(params.requestId)) {
              continue;
            }

            const entry = entries.find(
              entry => entry._requestId === params.requestId
            );
            if (!entry) {
              debug(
                `Received network data for requestId ${
                params.requestId
                } with no matching request.`
              );
              continue;
            }
            // It seems that people sometimes have an entry without a response,
            // I wonder how that works
            // https://github.com/sitespeedio/sitespeed.io/issues/2645
            if (entry.response) {
              entry.response.content.size += params.dataLength;
            }
          }
          break;

        case 'Network.loadingFinished':
          {
            if (pages.length < 1) {
              //we haven't loaded any pages yet.
              continue;
            }
            if (ignoredRequests.has(params.requestId)) {
              ignoredRequests.delete(params.requestId);
              continue;
            }

            const entry = entries.find(
              entry => entry._requestId === params.requestId
            );
            if (!entry) {
              debug(
                `Network loading finished for requestId ${
                params.requestId
                } with no matching request.`
              );
              continue;
            }
            if (options.includeCustomProperties) {
              attachCustomProps(entry, params);
            }

            if (entry._fromCache === 'memory') {
              entry.time = 0;
              entry.timings = cachedTimings(entry.__requestWillBeSentTime, params.timestamp);
            } else {
              const timings = entry.timings || {};
              const startTime = entry.__requestWillBeSentTime || entry._requestTime;
              timings.receive = formatMillis((params.timestamp - startTime) * 1000 - entry.__receiveHeadersEnd);
              const fullTime = max(0, timings.blocked) + max(0, timings.dns) + max(0, timings.connect) +
                max(0, timings.send) + max(0, timings.wait) + max(0, timings.receive);
              entry.time = Math.floor(1000 * fullTime) / 1000;
            }
            // For cached entries, Network.loadingFinished can have an earlier
            // timestamp than Network.dataReceived

            // encodedDataLength will be -1 sometimes
            if (params.encodedDataLength >= 0) {
              const response = entry.response;
              if (response) {
                response._transferSize = params.encodedDataLength;
                response.bodySize = params.encodedDataLength;

                if (
                  isHttp1x(response.httpVersion) &&
                  response.headersSize > -1
                ) {
                  response.bodySize -= response.headersSize;
                }

                const compression = Math.max(
                  0,
                  response.content.size - response.bodySize
                );
                if (compression > 0) {
                  response.content.compression = compression;
                }
              }
            }
          }
          break;

        case 'Page.loadEventFired':
          {
            if (pages.length < 1) {
              //we haven't loaded any pages yet.
              continue;
            }

            const page = pages[pages.length - 1];

            if (params.timestamp && page.__timestamp) {
              page.pageTimings.onLoad = formatMillis(
                (params.timestamp - page.__timestamp) * 1000
              );
            }
          }
          break;

        case 'Page.domContentEventFired':
          {
            if (pages.length < 1) {
              //we haven't loaded any pages yet.
              continue;
            }

            const page = pages[pages.length - 1];

            if (params.timestamp && page.__timestamp) {
              page.pageTimings.onContentLoad = formatMillis(
                (params.timestamp - page.__timestamp) * 1000
              );
            }
          }
          break;

        case 'Page.frameAttached':
          {
            const frameId = params.frameId,
              parentId = params.parentFrameId;

            rootFrameMappings.set(frameId, parentId);

            let grandParentId = rootFrameMappings.get(parentId);
            while (grandParentId) {
              rootFrameMappings.set(frameId, grandParentId);
              grandParentId = rootFrameMappings.get(grandParentId);
            }
          }
          break;

        case 'Network.loadingFailed':
          {
            if (ignoredRequests.has(params.requestId)) {
              ignoredRequests.delete(params.requestId);
              continue;
            }

            const entry = entries.find(
              entry => entry._requestId === params.requestId
            );
            if (!entry) {
              debug(
                `Network loading failed for requestId ${
                params.requestId
                } with no matching request.`
              );
              continue;
            }

            if (options.includeCustomProperties) {
              attachCustomProps(entry, params);
            }
            entry._transferSize = 0;
            entry.request.httpVersion = entry.request.httpVersion || "";
            entry.response = Object.assign(entry.response || blockedResponse(), { _error: params.errorText });
            entry.timings = entry.timings || blockedTimings();
            entry.serverIPAddress = "";
            entry.comment = `Error: ${params.errorText}${params.blockedReason ? `. Reason: ${params.blockedReason}` : ''}`
          }
          break;

        case 'Network.resourceChangedPriority':
          {
            const entry = entries.find(
              entry => entry._requestId === params.requestId
            );

            if (!entry) {
              debug(
                `Received resourceChangedPriority for requestId ${
                params.requestId
                } with no matching request.`
              );
              continue;
            }

            entry._priority = message.params.newPriority;
          }
          break;

        case 'Network.responseReceivedExtraInfo':
          {
            const entry = entries.find(
              entry => entry._requestId === params.requestId
            );

            responseExtraInfo.set(params.requestId, params);
            if (!entry) {
              debug(
                `Received responseReceivedExtraInfo for requestId ${
                params.requestId
                } with no matching request.`
              );
              continue;
            }
            if (entry.response) {
              addResponseExtraInfo(entry.response, params);
            }
          }
          break;

        case 'Network.requestWillBeSentExtraInfo':
          {
            const entry = entries.find(
              entry => entry._requestId === params.requestId
            );

            requestExtraInfo.set(params.requestId, params);
            if (!entry) {
              debug(
                `Received requestWillBeSentExtraInfo for requestId ${
                params.requestId
                } with no matching request.`
              );
              continue;
            }
            if (entry.request) {
              addRequestExtraInfo(entry, params);
            }
          }
          break;

        default:
          // Keep the old functionallity and log unknown events
          ignoredEvents(method);
          break;
      }
    }

    if (!options.includeResourcesFromDiskCache) {
      entries = entries.filter(
        entry => entry.cache.beforeRequest === undefined
      );
    }

    const deleteInternalProperties = o => {
      // __ properties are only for internal use, _ properties are custom properties for the HAR
      for (const prop in o) {
        if (prop.startsWith('__')) {
          delete o[prop];
        }
      }
      return o;
    };

    entries = entries
      .filter(entry => {
        if (!entry.response) {
          debug(`Dropping incomplete request: ${entry.request.url}`);
        }
        return entry.response;
      })
      .map(deleteInternalProperties);
    pages = pages.map(deleteInternalProperties);
    pages = pages.reduce((result, page, index) => {
      const hasEntry = entries.some(entry => entry.pageref === page.id);
      if (hasEntry) {
        result.push(page);
      } else {
        debug(`Skipping empty page: ${index + 1}`);
      }
      return result;
    }, []);
    const pagerefMapping = pages.reduce((result, page, index) => {
      result[page.id] = `page_${index + 1}`;
      return result;
    }, {});

    pages = pages.map(page => {
      page.id = pagerefMapping[page.id];
      return page;
    });
    entries = entries.map(entry => {
      entry.pageref = pagerefMapping[entry.pageref];
      return entry;
    });

    // FIXME sanity check if there are any pages/entries created

    return {
      log: {
        version: '1.2',
        creator: { name: options.name, version: options.version, comment: options.comment },
        pages,
        entries,
        _meta: options.meta
      }
    };
  }
};

function addRequestExtraInfo(request, requestExtraInfo) {
  if (requestExtraInfo.headers) {
    request.headers = parseHeaders(requestExtraInfo.headers);
  }
  if (requestExtraInfo.associatedCookies) {
    try {
      request.cookies = requestExtraInfo.associatedCookies
        .filter(({ blockedReasons }) => !blockedReasons.length)
        .map(({ cookie }) => formatCookie(cookie));
    } catch(err) {
      // better safe than sorry.
    }
  }
}

function addResponseExtraInfo(response, responseExtraInfo) {
  if (responseExtraInfo.headers) {
    response.headers = parseHeaders(responseExtraInfo.headers);
  }
  if (responseExtraInfo.blockedCookies) {
    try {
      response.cookies = response.cookies.filter(
        ({ name }) => !responseExtraInfo.blockedCookies.find(blockedCookie => {
          if (blockedCookie.cookie) {
            return blockedCookie.cookie.name === name;
          }

          if (blockedCookie.cookieLine) {
            const cookie = parseResponseCookies(blockedCookie.cookieLine)[0];
            if (cookie) {
              return cookie.name === name;
            }
          }

          return false;
        })
      );
    } catch (err) {
      // better safe than sorry
    }
  }
}
