/** Hint links.

    TODO:

    important
        Connect to input system
        Gluing into tridactyl
    unimportant
        Frames
        Redraw on reflow
*/

import * as DOM from './dom'
import {log} from './math'
import {permutationsWithReplacement, islice, izip, map} from './itertools'
import {hasModifiers} from './keyseq'
import state from './state'
import {messageActiveTab, message} from './messaging'
import * as config from './config'
import * as TTS from './text_to_speech'
import {HintSaveType} from './hinting_background'
import Logger from './logging'
const logger = new Logger('hinting')

/** Simple container for the state of a single frame's hints. */
class HintState {
    public focusedHint: Hint
    readonly hintHost = document.createElement('div')
    readonly hints: Hint[] = []
    public filter = ''
    public hintchars = ''

    constructor(
        public filterFunc: HintFilter = defaultHintFilters[config.get('hintmode')],
    ){
        this.hintHost.classList.add("TridactylHintHost")
    }

    destructor() {
        // Undo any alterations of the hinted elements
        for (const hint of this.hints) {
            hint.hidden = true
        }

        // Remove all hints from the DOM.
        this.hintHost.remove()
    }
}

let modeState: HintState = undefined

/** For each hintable element, add a hint */
export function hintPage(
    hintableElements: Element[],
    onSelect: HintSelectedCallback,
    buildHints: HintBuilder = defaultHintBuilders[config.get('hintmode')],
    filterHints: HintFilter = defaultHintFilters[config.get('hintmode')],
) {
    state.mode = 'hint'
    modeState = new HintState(filterHints)
    buildHints(hintableElements, onSelect)

    if (modeState.hints.length) {
        logger.debug("hints", modeState.hints)
        modeState.focusedHint = modeState.hints[0]
        modeState.focusedHint.focused = true
        document.body.appendChild(modeState.hintHost)
    } else {
        reset()
    }
}

let defaultHintBuilders = {
    'simple': buildHintsSimple,
    'vimperator': buildHintsVimperator,
}

let defaultHintFilters = {
    'simple': filterHintsSimple,
    'vimperator': filterHintsVimperator,
}

/** vimperator-style minimal hint names */
function* hintnames(n: number, hintchars = config.get("hintchars")): IterableIterator<string> {
    let taglen = 1
    var source = permutationsWithReplacement(hintchars, taglen)
    for (let i = 0;i < Math.floor(n / hintchars.length);i++) {
        // drop hints that will be used as the prefix of longer hints
        if (source.next()['done']) {
            // if the current taglen tags are exhausted, increase the length
            taglen++
            source = permutationsWithReplacement(hintchars, taglen)
            source.next()
        }
    }
    while (true) {
        yield* map(source, e=>{
            return e.join('')
        })
        taglen++
        source = permutationsWithReplacement(hintchars, taglen)
    }
}

/** Uniform length hintnames */
function* hintnames_uniform(n: number, hintchars = config.get("hintchars")): IterableIterator<string> {
    if (n <= hintchars.length)
        yield* islice(hintchars[Symbol.iterator](), n)
    else {
        // else calculate required length of each tag
        const taglen = Math.ceil(log(n, hintchars.length))
        // And return first n permutations
        yield* map(islice(permutationsWithReplacement(hintchars, taglen), n),
            perm => {
                return perm.join('')
            })
    }
}

type HintSelectedCallback = (Hint) => any

/** Place a flag by each hintworthy element */
class Hint {
    private readonly flag = document.createElement('span')

    constructor(
        private readonly target: Element,
        public readonly name: string,
        public readonly filterData: any,
        private readonly onSelect: HintSelectedCallback
    ) {
        const rect = target.getClientRects()[0]
        this.flag.textContent = name
        this.flag.className = 'TridactylHint'
        /* this.flag.style.cssText = ` */
        /*     top: ${rect.top}px; */
        /*     left: ${rect.left}px; */
        /* ` */
        this.flag.style.cssText = `
            top: ${window.scrollY + rect.top}px;
            left: ${window.scrollX + rect.left}px;
        `
        modeState.hintHost.appendChild(this.flag)
        target.classList.add('TridactylHintElem')
    }

    // These styles would be better with pseudo selectors. Can we do custom ones?
    // If not, do a state machine.
    set hidden(hide: boolean) {
        this.flag.hidden = hide
        if (hide) {
            this.focused = false
            this.target.classList.remove('TridactylHintElem')
        } else
            this.target.classList.add('TridactylHintElem')
    }

    set focused(focus: boolean) {
        if (focus) {
            this.target.classList.add('TridactylHintActive')
            this.target.classList.remove('TridactylHintElem')
        } else {
            this.target.classList.add('TridactylHintElem')
            this.target.classList.remove('TridactylHintActive')
        }
    }

    select() {
        this.onSelect(this)
    }
}

type HintBuilder = (els: Element[], onSelect: HintSelectedCallback) => void

function buildHintsSimple(els: Element[], onSelect: HintSelectedCallback) {
    let names = hintnames(els.length)
    for (let [el, name] of izip(els, names)) {
        logger.debug({el, name})
        modeState.hintchars += name
        modeState.hints.push(new Hint(el, name, null, onSelect))
    }
}

function buildHintsVimperator(els: Element[], onSelect: HintSelectedCallback) {
    let names = hintnames(els.length)
    for (let [el, name] of izip(els, names)) {
        let ft = elementFilterableText(el)
		// strip out non-alphanumeric characters and hintchars.
		ft = ft.replace(new RegExp('[' + config.get('hintchars') + ']|[^[:alnum:]]', 'gi'), '')
        logger.debug({el, name, ft})
        modeState.hintchars += name + ft
        modeState.hints.push(new Hint(el, name, ft, onSelect))
    }
}

function elementFilterableText(el: Element): string {
    let nodename = el.nodeName.toLowerCase()
    if (nodename == 'input') {
        // } else if (nodename == 'a'
        //            && !el.textContent.trim()
        //            && el.firstElementChild
        //            && el.firstElementChild.nodeName.toLowerCase() == 'img') {
        //     return el.firstElementChild.alt || el.firstElementChild.title
    } else if (0 < el.textContent.length) {
        return el.textContent.toLowerCase()
    } else if (el.hasAttribute('title')) {
        return el.getAttribute('title').toLowerCase()
    } else {
        return el.innerHTML.toLowerCase()
    }
}

function filter(fstr) {
    modeState.filterFunc(fstr)
}

type HintFilter = (string) => void

/** Show only hints prefixed by fstr. Focus first match */
function filterHintsSimple(fstr) {
    const active: Hint[] = []
    let foundMatch
    for (let h of modeState.hints) {
        if (!h.name.startsWith(fstr)) h.hidden = true
        else {
            if (! foundMatch) {
                h.focused = true
                modeState.focusedHint = h
                foundMatch = true
            }
            h.hidden = false
            active.push(h)
        }

    }
    if (active.length == 1) {
        selectFocusedHint()
    }
}

/** Show only hints:
    - prefixed by the subset of fstr in the hintchars config.
    - containing the rest of fstr as a subsequence in a dwim-type
      chunk of their html.
    Focus the first match.
**/
function filterHintsVimperator(fstr) {
    const active: Hint[] = []
    let foundMatch
    for (let h of modeState.hints) {
        if (!filterHintsVimperatorPredicate(fstr, h)) {
            h.hidden = true
        } else {
            if (! foundMatch) {
                h.focused = true
                modeState.focusedHint = h
                foundMatch = true
            }
            h.hidden = false
            active.push(h)
        }

    }
    if (active.length == 1) {
        selectFocusedHint()
    }
}

function filterHintsVimperatorPredicate(fstr, h) {
    let configHintchars = config.get("hintchars")
    let fstrName = ''

    let curIdx = 0
    for (let c of fstr) {
        if (configHintchars.includes(c)) {
            fstrName = fstrName + c
            if (!h.name.startsWith(fstrName)) {
                return false
            }
        } else {
            curIdx = h.filterData.indexOf(c.toLowerCase(), curIdx)
            if (-1 == curIdx) {
                return false
            }
        }
    }
    return true
}

/** Remove all hints, reset STATE. */
function reset() {
    modeState.destructor()
    modeState = undefined
    state.mode = 'normal'
}

/** If key is in hintchars, add it to filtstr and filter */
function pushKey(ke) {
    if (hasModifiers(ke)) {
        return
    } else if (ke.key === 'Backspace') {
        modeState.filter = modeState.filter.slice(0,-1)
        filter(modeState.filter)
    } else if (ke.key.length > 1) {
        return
    } else if (modeState.hintchars.includes(ke.key)) {
        modeState.filter += ke.key
        filter(modeState.filter)
    }
}

/** Array of hintable elements in viewport

    Elements are hintable if
        1. they can be meaningfully selected, clicked, etc
        2. they're visible
            1. Within viewport
            2. Not hidden by another element
*/
function hintables(selectors=HINTTAGS_selectors) {
    return DOM.getElemsBySelector(selectors, [DOM.isVisible])
}

function elementswithtext() {

    return DOM.getElemsBySelector("*",
        [DOM.isVisible, hint => {
            return hint.textContent != ""
        }]
    )
}

/** Returns elements that point to a saveable resource
 */
function saveableElements() {
    return DOM.getElemsBySelector(HINTTAGS_saveable, [DOM.isVisible])
}

/** Get array of images in the viewport
 */
function hintableImages() {
    return DOM.getElemsBySelector(HINTTAGS_img_selectors, [DOM.isVisible])
}

/** Get arrat of "anchors": elements which have id or name and can be addressed
 * with the hash/fragment in the URL
 */
function anchors() {
    return DOM.getElemsBySelector(HINTTAGS_anchor_selectors, [DOM.isVisible])
}

/** Array of items that can be killed with hint kill
 */
function killables() {
    return DOM.getElemsBySelector(HINTTAGS_killable_selectors, [DOM.isVisible])
}

// CSS selectors. More readable for web developers. Not dead. Leaves browser to care about XML.
const HINTTAGS_selectors = `
input:not([type=hidden]):not([disabled]),
a,
area,
iframe,
textarea,
button,
select,
summary,
[onclick],
[onmouseover],
[onmousedown],
[onmouseup],
[oncommand],
[role='link'],
[role='button'],
[role='checkbox'],
[role='combobox'],
[role='listbox'],
[role='listitem'],
[role='menuitem'],
[role='menuitemcheckbox'],
[role='menuitemradio'],
[role='option'],
[role='radio'],
[role='scrollbar'],
[role='slider'],
[role='spinbutton'],
[role='tab'],
[role='textbox'],
[role='treeitem'],
[class*='button'],
[tabindex]
`

const HINTTAGS_img_selectors = `
img,
[src]
`

const HINTTAGS_anchor_selectors = `
[id],
[name]
`

const HINTTAGS_killable_selectors = `
span,
div,
iframe,
img,
button,
article,
summary
`

/** CSS selector for elements which point to a saveable resource
 */
const HINTTAGS_saveable = `
[href]:not([href='#'])
`

import {activeTab, browserBg, l, firefoxVersionAtLeast} from './lib/webext'

async function openInBackground(url: string) {
    const thisTab = await activeTab()
    const options: any = {
        active: false,
        url,
        index: thisTab.index + 1,
    }
    if (await l(firefoxVersionAtLeast(57))) options.openerTabId = thisTab.id
    return browserBg.tabs.create(options)
}

/** if `target === _blank` clicking the link is treated as opening a popup and is blocked. Use webext API to avoid that. */
function simulateClick(target: HTMLElement) {
    // target can be set to other stuff, and we'll fail in annoying ways.
    // There's no easy way around that while this code executes outside of the
    // magic 'short lived event handler' context.
    //
    // OTOH, hardly anyone uses that functionality any more.
    if ((target as HTMLAnchorElement).target === '_blank' ||
        (target as HTMLAnchorElement).target === '_new'
    ) {
        browserBg.tabs.create({url: (target as HTMLAnchorElement).href})
    } else {
        DOM.mouseEvent(target, "click")
        // Sometimes clicking the element doesn't focus it sufficiently.
        target.focus()
    }
}

function hintPageOpenInBackground() {
    hintPage(hintables(), hint=>{
        hint.target.focus()
        if (hint.target.href) {
            // Try to open with the webext API. If that fails, simulate a click on this page anyway.
            openInBackground(hint.target.href).catch(()=>simulateClick(hint.target))
        } else {
            // This is to mirror vimperator behaviour.
            simulateClick(hint.target)
        }
    })
}

function hintPageSimple(selectors=HINTTAGS_selectors) {
    hintPage(hintables(selectors), hint=>{
        simulateClick(hint.target)
    })
}

function hintPageTextYank() {
    hintPage(elementswithtext(), hint=>{
        messageActiveTab("commandline_frame", "setClipboard", [hint.target.textContent])
    })
}

function hintPageYank() {
    hintPage(hintables(), hint=>{
        messageActiveTab("commandline_frame", "setClipboard", [hint.target.href])
    })
}

/** Hint anchors and yank the URL on selection
 */
function hintPageAnchorYank() {

    hintPage(anchors(), hint=>{

        let anchorUrl = new URL(window.location.href)

        anchorUrl.hash = hint.target.id || hint.target.name;

        messageActiveTab("commandline_frame", "setClipboard", [anchorUrl.href])
    })
}

/** Hint images, opening in the same tab, or in a background tab
 *
 * @param inBackground  opens the image source URL in a background tab,
 *                      as opposed to the current tab
 */
function hintImage(inBackground) {
    hintPage(hintableImages(), hint=>{
        let img_src = hint.target.getAttribute("src")

        if (inBackground) {
            openInBackground(new URL(img_src, window.location.href).href)
        } else {
            window.location.href = img_src
        }
    })
}

/** Hint elements to focus */
function hintFocus() {
    hintPage(hintables(), hint=>{
        hint.target.focus()
    })
}

/** Hint items and read out the content of the selection */
function hintRead() {
    hintPage(elementswithtext(), hint=>{
        TTS.readText(hint.target.textContent)
    })
}

/** Hint elements and delete the selection from the page
 */
function hintKill() {
    hintPage(killables(), hint=>{
        hint.target.remove();
    })
}

/** Hint link elements to save
 *
 * @param hintType  the type of elements to hint and save:
 *                      - "link": elements that point to another resource (eg
 *                        links to pages/files) - the link targer is saved
 *                      - "img": image elements
 * @param saveAs    prompt for save location
 */
function hintSave(hintType: HintSaveType, saveAs: boolean) {

    function saveHintElems(hintType) {
        return (hintType === "link") ? saveableElements() : hintableImages()
    }

    function urlFromElem(hintType, elem) {
        return (hintType === "link") ? elem.href : elem.src
    }

    hintPage(saveHintElems(hintType), hint=>{

        const urlToSave = new URL(urlFromElem(hintType, hint.target),
            window.location.href)

        // Pass to background context to allow saving from data URLs.
        // Convert to href because can't clone URL across contexts
        message('download_background', "downloadUrl",
            [urlToSave.href, saveAs])
    })
}

function selectFocusedHint() {
    logger.debug("Selecting hint.", state.mode)
    const focused = modeState.focusedHint
    reset()
    focused.select()
}

import {addListener, attributeCaller} from './messaging'
addListener('hinting_content', attributeCaller({
    pushKey,
    selectFocusedHint,
    reset,
    hintPageSimple,
    hintPageYank,
    hintPageTextYank,
    hintPageAnchorYank,
    hintPageOpenInBackground,
    hintImage,
    hintFocus,
    hintRead,
    hintKill,
    hintSave,
}))
