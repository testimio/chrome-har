import {
    DevtoolsProtocolEventMap,
} from './nicerChromeDevToolsTypes';

import type { Har } from 'har-format';

// Possible events, from the switch case inside chrome-har code
// We can expand if to all kind of events easily
declare const possibleEvents: [
    'Network.dataReceived',
    'Network.loadingFailed',
    'Network.loadingFinished',
    'Network.requestServedFromCache',
    'Network.requestWillBeSent',
    'Network.resourceChangedPriority',
    'Network.responseReceived',
    'Page.domContentEventFired',
    'Page.frameAttached',
    'Page.frameScheduledNavigation',
    'Page.frameStartedLoading',
    'Page.loadEventFired',
    'Page.navigatedWithinDocument',
];

// this will make it take all events
// export type ChromeHarMessage = DevtoolsProtocolEventMap[keyof DevtoolsProtocolEventMap];
export type ChromeHarMessage = DevtoolsProtocolEventMap[typeof possibleEvents[number]];

export type HarFromMessages = (
    messages: ChromeHarMessage[],
    options: { includeResourcesFromDiskCache?: boolean; includeTextFromResponseBody?: boolean; name?: string; version?: string; comment?: string }
) => Har;

export declare const harFromMessages: HarFromMessages;