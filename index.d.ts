import {
    DevtoolsProtocolEventMap,
} from './nicerChromeDevToolsTypes';

// Possible events, from the switch case inside chrome-har code
// We can expand if to all kind of events easily
declare const possibleEvents: [
    'Page.frameStartedLoading',
    'Page.frameScheduledNavigation',
    'Page.navigatedWithinDocument',
    'Network.requestWillBeSent',
    'Network.requestServedFromCache',
    'Network.responseReceived',
    'Network.dataReceived',
    'Network.loadingFinished',
    'Page.loadEventFired',
    'Page.domContentEventFired',
    'Page.frameAttached',
    'Network.loadingFailed',
    'Network.resourceChangedPriority',
];

export type ChromeHarMessage = DevtoolsProtocolEventMap[typeof possibleEvents[number]];

export type HarFromMessages = (
    messages: ChromeHarMessage[],
    options: { includeResourcesFromDiskCache?: boolean; includeTextFromResponseBody?: boolean }
) => void;

export declare const harFromMessages: HarFromMessages;