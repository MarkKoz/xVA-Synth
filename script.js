"use strict"

window.appVersion = "v1.4.0"

const PRODUCTION = process.mainModule.filename.includes("resources")
const path = PRODUCTION ? "./resources/app" : "."
window.path = path

const fs = require("fs")
const zipdir = require('zip-dir')
const {shell, ipcRenderer} = require("electron")
const fetch = require("node-fetch")
const {text_to_sequence, english_cleaners} = require("./text.js")
const {xVAAppLogger} = require("./appLogger.js")
window.appLogger = new xVAAppLogger(`./app.log`, window.appVersion)
process.on(`uncaughtException`, data => window.appLogger.log(data))
window.onerror = (err, url, lineNum) => window.appLogger.log(err)
require("./i18n.js")
require("./util.js")
const {saveUserSettings, deleteFolderRecursive} = require("./settingsMenu.js")
const xVASpeech = require("./xVASpeech.js")
const {startBatch} = require("./batch.js")
window.electronBrowserWindow = require("electron").remote.getCurrentWindow()
const child = require("child_process").execFile
const spawn = require("child_process").spawn

const {PluginsManager} = require("./plugins_manager.js")
window.pluginsManager = new PluginsManager(window.path, window.appLogger, window.appVersion)
window.pluginsManager.runPlugins(window.pluginsManager.pluginsModules["start"]["pre"], event="pre start")

let themeColour
const oldCError = console.error
console.error = (data) => {
    window.appLogger.log(data)
    oldCError(arguments)
}

window.addEventListener("error", function (e) {window.appLogger.log(e.error.stack)})
window.addEventListener('unhandledrejection', function (e) {window.appLogger.log(e.reason.stack)})

window.games = {}
window.models = {}
window.pitchEditor = {letters: [], currentVoice: null, resetPitch: null, resetDurs: null, letterFocus: [], ampFlatCounter: 0, hasChanged: false}
window.currentModel = undefined
window.currentModelButton = undefined
window.watchedModelsDirs = []

window.appLogger.log(`Settings: ${JSON.stringify(window.userSettings)}`)

// Set up folders
try {fs.mkdirSync(`${path}/models`)} catch (e) {/*Do nothing*/}
try {fs.mkdirSync(`${path}/output`)} catch (e) {/*Do nothing*/}
try {fs.mkdirSync(`${path}/assets`)} catch (e) {/*Do nothing*/}

// Clean up temp files
fs.readdir(`${__dirname}/output`, (err, files) => {
    if (err) {
        window.appLogger.log(err)
    }
    if (files && files.length) {
        files.filter(f => f.startsWith("temp-")).forEach(file => {
            fs.unlink(`${__dirname}/output/${file}`, err => err&&console.log(err))
        })
    }
})

let fileRenameCounter = 0
let fileChangeCounter = 0
let isGenerating = false

window.loadAllModels = () => {
    return new Promise(resolve => {

        let gameFolder
        let modelPathsKeys = Object.keys(window.userSettings).filter(key => key.includes("modelspath_"))
        window.games = {}

        modelPathsKeys.forEach(modelsPathKey => {
            const modelsPath = window.userSettings[modelsPathKey]
            try {
                const files = fs.readdirSync(modelsPath).filter(f => f.endsWith(".json"))

                if (!files.length) {
                    return
                }

                files.forEach(fileName => {

                    gameFolder = modelsPathKey.split("_")[1]

                    try {
                        if (!models.hasOwnProperty(`${gameFolder}/${fileName}`)) {
                            models[`${gameFolder}/${fileName}`] = null
                        }

                        const model = JSON.parse(fs.readFileSync(`${modelsPath}/${fileName}`, "utf8"))
                        model.games.forEach(({gameId, voiceId, voiceName, voiceDescription, gender}) => {

                            if (!window.games.hasOwnProperty(gameId)) {

                                const gameAsset = fs.readdirSync(`${path}/assets`).find(f => f.startsWith(gameId))
                                const option = document.createElement("option")
                                option.value = gameAsset
                                option.innerHTML = gameAsset.split("-").reverse()[0].split(".")[0]
                                window.games[gameId] = {
                                    models: [],
                                    gameAsset
                                }
                            }

                            const audioPreviewPath = `${modelsPath}/${model.games.find(({gameId}) => gameId==gameFolder).voiceId}`
                            const existingDuplicates = []
                            window.games[gameId].models.forEach((item,i) => {
                                if (item.voiceId==voiceId) {
                                    existingDuplicates.push([item, i])
                                }
                            })

                            const modelData = {model, modelsPath, audioPreviewPath, gameId, voiceId, voiceName, voiceDescription, gender, modelVersion: model.modelVersion, hifi: undefined, xvaspeech: undefined}
                            const potentialHiFiPath = `${modelsPath}/${voiceId}.hg.pt`
                            if (fs.existsSync(potentialHiFiPath)) {
                                modelData.hifi = potentialHiFiPath
                            }
                            const potentialxVASpeechPath = `${modelsPath}/${voiceId}.xvaspeech.pt`
                            if (fs.existsSync(potentialxVASpeechPath)) {
                                modelData.xvaspeech = potentialxVASpeechPath
                            }

                            if (existingDuplicates.length) {
                                if (existingDuplicates[0][0].modelVersion<model.modelVersion) {
                                    window.games[gameId].models.splice(existingDuplicates[0][1], 1)
                                    window.games[gameId].models.push(modelData)
                                }
                            } else {
                                window.games[gameId].models.push(modelData)
                            }
                        })
                    } catch (e) {
                        console.log(e)
                        window.appLogger.log(`${window.i18n.ERR_LOADING_MODELS_FOR_GAME_WITH_FILENAME.replace("_1", gameFolder)} `+fileName)
                        window.appLogger.log(e)
                        window.appLogger.log(e.stack)
                    }
                })
            } catch (e) {
                console.log(e)
                window.appLogger.log(`${window.i18n.ERR_LOADING_MODELS_FOR_GAME}: `+ gameFolder)
                window.appLogger.log(e)
            }

            resolve()
        })
    })
}
setting_models_path_input.addEventListener("change", () => {
    const gameFolder = window.currentGame[0]

    setting_models_path_input.value = setting_models_path_input.value.replace(/\/\//g, "/").replace(/\\/g,"/")
    window.userSettings[`modelspath_${gameFolder}`] = setting_models_path_input.value
    saveUserSettings()
    loadAllModels().then(() => {
        changeGame(window.currentGame.join("-"))
    })

    if (!window.watchedModelsDirs.includes(setting_models_path_input.value)) {
        window.watchedModelsDirs.push(setting_models_path_input.value)
        fs.watch(setting_models_path_input.value, {recursive: false, persistent: true}, (eventType, filename) => {
            changeGame(window.currentGame.join("-"))
        })
    }
})

// Change game
window.changeGame = (meta) => {

    meta = meta.split("-")
    window.currentGame = meta
    themeColour = meta[1]
    generateVoiceButton.disabled = true
    generateVoiceButton.innerHTML = window.i18n.GENERATE_VOICE
    selectedGameDisplay.innerHTML = meta[3].split(".")[0]


    // Change batch panel colours, if it is initialized
    try {
        Array.from(batchRecordsHeader.children).forEach(item => item.style.backgroundColor = `#${window.currentGame[1]}`)
    } catch (e) {}
    try {
        Array.from(pluginsRecordsHeader.children).forEach(item => item.style.backgroundColor = `#${window.currentGame[1]}`)
    } catch (e) {}

    // Change the app title
    title.innerHTML = window.i18n.SELECT_VOICE_TYPE
    if (window.games[window.currentGame[0]] == undefined) {
        title.innerHTML = `${window.i18n.NO_MODELS_IN}: ${window.userSettings[`modelspath_${window.currentGame[0]}`]}`
        console.log(title.innerHTML)
    } else if (meta[2]) {
        document.title = `${meta[2]}VA Synth`
        dragBar.innerHTML = `${meta[2]}VA Synth`
    } else {
        document.title = `xVA Synth`
        dragBar.innerHTML = `xVA Synth`
    }

    const gameFolder = meta[0]
    const gameName = meta[meta.length-1].split(".")[0]

    setting_models_path_container.style.display = "flex"
    setting_out_path_container.style.display = "flex"
    setting_models_path_label.innerHTML = `<i style="display:inline">${gameName}</i><span>${window.i18n.SETTINGS_MODELS_PATH}</span>`
    setting_models_path_input.value = window.userSettings[`modelspath_${gameFolder}`]
    setting_out_path_label.innerHTML = `<i style="display:inline">${gameName}</i> ${window.i18n.SETTINGS_OUTPUT_PATH}`
    setting_out_path_input.value = window.userSettings[`outpath_${gameFolder}`]

    if (meta) {
        const background = `linear-gradient(0deg, rgba(128,128,128,${window.userSettings.bg_gradient_opacity}) 0px, rgba(0,0,0,0)), url("assets/${meta.join("-")}")`
        Array.from(document.querySelectorAll("button")).forEach(e => e.style.background = `#${themeColour}`)
        Array.from(document.querySelectorAll(".voiceType")).forEach(e => e.style.background = `#${themeColour}`)
        Array.from(document.querySelectorAll(".spinner")).forEach(e => e.style.borderLeftColor = `#${themeColour}`)

        // Fade the background image transition
        rightBG1.style.background = background
        rightBG2.style.opacity = 0
        setTimeout(() => {
            rightBG2.style.background = rightBG1.style.background
            rightBG2.style.opacity = 1
        }, 1000)
    }

    cssHack.innerHTML = `::selection {
        background: #${themeColour};
    }
    ::-webkit-scrollbar-thumb {
        background-color: #${themeColour} !important;
    }
    .slider::-webkit-slider-thumb {
        background-color: #${themeColour} !important;
    }
    a {color: #${themeColour}};
    #batchRecordsHeader > div {background-color: #${themeColour} !important;}
    #pluginsRecordsHeader > div {background-color: #${themeColour} !important;}
    `

    try {fs.mkdirSync(`${path}/output/${meta[0]}`)} catch (e) {/*Do nothing*/}
    localStorage.setItem("lastGame", window.currentGame.join("-"))

    // Populate models
    voiceTypeContainer.innerHTML = ""
    voiceSamples.innerHTML = ""


    // No models found
    if (!Object.keys(window.games).length) {
        title.innerHTML = window.i18n.NO_MODELS_FOUND
        return
    }

    const buttons = []

    voiceSearchInput.placeholder = window.i18n.SEARCH_N_VOICES.replace("_", window.games[meta[0]] ? window.games[meta[0]].models.length : "0")
    voiceSearchInput.value = ""

    if (!window.games[meta[0]]) {
        return
    }

    window.games[meta[0]].models.forEach(({model, modelsPath, audioPreviewPath, gameId, voiceId, voiceName, voiceDescription, hifi}) => {

        const button = createElem("div.voiceType", voiceName)
        button.style.background = `#${themeColour}`
        button.dataset.modelId = voiceId

        // Quick voice set preview, if there is a preview file
        button.addEventListener("contextmenu", () => {
            window.appLogger.log(`${audioPreviewPath}.wav`)
            const audioPreview = createElem("audio", {autoplay: false}, createElem("source", {
                src: `${audioPreviewPath}.wav`
            }))
        })

        button.addEventListener("click", event => {

            // Just for easier packaging of the voice models for publishing - yes, lazy
            if (event.ctrlKey && event.shiftKey) {
                if (event.altKey) {
                    const files = fs.readdirSync(`./output`).filter(fname => fname.includes("temp-") && fname.includes(".wav"))
                    if (files.length) {
                        const options = {
                            hz: window.userSettings.audio.hz,
                            padStart: window.userSettings.audio.padStart,
                            padEnd: window.userSettings.audio.padEnd,
                            bit_depth: window.userSettings.audio.bitdepth,
                            amplitude: window.userSettings.audio.amplitude
                        }

                        fetch(`http://localhost:8008/outputAudio`, {
                            method: "Post",
                            body: JSON.stringify({
                                input_path: `./output/${files[0]}`,
                                output_path: `${modelsPath}/${voiceId}.wav`,
                                options: JSON.stringify(options)
                            })
                        }).then(r=>r.text()).then(console.log)
                    }

                } else {
                    fs.mkdirSync(`./build/${voiceId}`)
                    fs.mkdirSync(`./build/${voiceId}/resources`)
                    fs.mkdirSync(`./build/${voiceId}/resources/app`)
                    fs.mkdirSync(`./build/${voiceId}/resources/app/models`)
                    fs.mkdirSync(`./build/${voiceId}/resources/app/models/${gameId}`)
                    fs.copyFileSync(`${modelsPath}/${voiceId}.json`, `./build/${voiceId}/resources/app/models/${gameId}/${voiceId}.json`)
                    fs.copyFileSync(`${modelsPath}/${voiceId}.wav`, `./build/${voiceId}/resources/app/models/${gameId}/${voiceId}.wav`)
                    fs.copyFileSync(`${modelsPath}/${voiceId}.pt`, `./build/${voiceId}/resources/app/models/${gameId}/${voiceId}.pt`)
                    if (hifi) {
                        fs.copyFileSync(`${modelsPath}/${voiceId}.hg.pt`, `./build/${voiceId}/resources/app/models/${gameId}/${voiceId}.hg.pt`)
                    }
                    zipdir(`./build/${voiceId}`, {saveTo: `./build/${voiceId}.zip`}, (err, buffer) => deleteFolderRecursive(`./build/${voiceId}`))
                }
                return
            }

            if (hifi) {
                // Remove the bespoke hifi option if there was one already there
                Array.from(vocoder_select.children).forEach(opt => {
                    if (opt.innerHTML=="Bespoke HiFi GAN") {
                        vocoder_select.removeChild(opt)
                    }
                })
                bespoke_hifi_bolt.style.opacity = 1
                const option = createElem("option", "Bespoke HiFi GAN")
                option.value = `${gameId}/${voiceId}.hg.pt`
                vocoder_select.appendChild(option)
            } else {
                bespoke_hifi_bolt.style.opacity = 0
                // Set the vocoder select to quick-and-dirty if bespoke hifi-gan was selected
                if (vocoder_select.value.includes(".hg.")) {
                    vocoder_select.value = "qnd"
                    changeVocoder("qnd")
                }
                // Remove the bespoke hifi option if there was one already there
                Array.from(vocoder_select.children).forEach(opt => {
                    if (opt.innerHTML=="Bespoke HiFi GAN") {
                        vocoder_select.removeChild(opt)
                    }
                })
            }

            const appVersionRequirement = model.version.toString().split(".").map(v=>parseInt(v))
            const appVersionInts = appVersion.replace("v", "").split(".").map(v=>parseInt(v))
            let appVersionOk = true
            if (appVersionRequirement[0] <= appVersionInts[0] ) {
                if (appVersionRequirement.length>1 && parseInt(appVersionRequirement[0]) == appVersionInts[0]) {
                    if (appVersionRequirement[1] <= appVersionInts[1] ) {
                        if (appVersionRequirement.length>2 && parseInt(appVersionRequirement[1]) == appVersionInts[1]) {
                            if (appVersionRequirement[2] <= appVersionInts[2] ) {
                            } else {
                                appVersionOk = false
                            }
                        }
                    } else {
                        appVersionOk = false
                    }
                }
            } else {
                appVersionOk = false
            }
            if (!appVersionOk) {
                window.errorModal(`${window.i18n.MODEL_REQUIRES_VERSION} v${model.version}<br><br>${window.i18n.THIS_APP_VERSION}: ${window.appVersion}`)
                return
            }

            window.currentModel = model
            window.currentModel.voiceId = voiceId
            window.currentModel.voiceName = button.innerHTML
            window.currentModel.hifi = hifi
            window.currentModel.audioPreviewPath = audioPreviewPath
            window.currentModelButton = button

            if (voiceDescription) {
                description.innerHTML = voiceDescription
                description.className = "withContent"
            } else {
                description.innerHTML = ""
                description.className = ""
            }

            generateVoiceButton.dataset.modelQuery = null

            // The model is already loaded. Don't re-load it.
            if (generateVoiceButton.dataset.modelIDLoaded == voiceId) {
                generateVoiceButton.innerHTML = window.i18n.GENERATE_VOICE
                generateVoiceButton.dataset.modelQuery = "null"

            } else {
                generateVoiceButton.innerHTML = window.i18n.LOAD_MODEL

                const modelGameFolder = audioPreviewPath.split("/")[0]

                generateVoiceButton.dataset.modelQuery = JSON.stringify({
                    outputs: parseInt(model.outputs),
                    model: `${modelsPath}/${voiceId}`,
                    model_speakers: model.emb_size,
                    cmudict: model.cmudict
                })
                generateVoiceButton.dataset.modelIDToLoad = voiceId
            }
            generateVoiceButton.disabled = false

            title.innerHTML = button.innerHTML
            title.dataset.modelId = voiceId
            keepSampleButton.style.display = "none"
            samplePlay.style.display = "none"

            // Voice samples
            voiceSamples.innerHTML = ""
            fs.readdir(`${window.userSettings[`outpath_${meta[0]}`]}/${button.dataset.modelId}`, (err, files) => {

                if (err) return

                files.forEach(file => {
                    if (file.endsWith(".json")) {
                        return
                    }
                    voiceSamples.appendChild(makeSample(`${window.userSettings[`outpath_${meta[0]}`]}/${button.dataset.modelId}/${file}`))
                })
            })
        })
        buttons.push(button)
    })

    buttons.sort((a,b) => a.innerHTML<b.innerHTML?-1:1)
        .forEach(button => voiceTypeContainer.appendChild(button))

}

const makeSample = (src, newSample) => {
    const fileName = src.split("/").reverse()[0].split("%20").join(" ")
    const fileFormat = fileName.split(".").reverse()[0]
    const sample = createElem("div.sample", createElem("div", fileName))
    const audioControls = createElem("div")
    const audio = createElem("audio", {controls: true}, createElem("source", {
        src: src,
        type: `audio/${fileFormat}`
    }))
    const openFileLocationButton = createElem("div", {title: window.i18n.OPEN_CONTAINING_FOLDER})
    openFileLocationButton.innerHTML = "&#10064;"
    openFileLocationButton.addEventListener("click", () => {
        shell.showItemInFolder(src)
    })

    if (fs.existsSync(`${src}.json`)) {
        const editButton = createElem("div", {title: window.i18n.ADJUST_SAMPLE_IN_EDITOR})
        editButton.innerHTML = `<svg class="renameSVG" version="1.0" xmlns="http:\/\/www.w3.org/2000/svg" width="344.000000pt" height="344.000000pt" viewBox="0 0 344.000000 344.000000" preserveAspectRatio="xMidYMid meet"><g transform="translate(0.000000,344.000000) scale(0.100000,-0.100000)" fill="#555555" stroke="none"><path d="M1489 2353 l-936 -938 -197 -623 c-109 -343 -195 -626 -192 -629 2 -3 284 84 626 193 l621 198 937 938 c889 891 937 940 934 971 -11 108 -86 289 -167 403 -157 219 -395 371 -655 418 l-34 6 -937 -937z m1103 671 c135 -45 253 -135 337 -257 41 -61 96 -178 112 -241 l12 -48 -129 -129 -129 -129 -287 287 -288 288 127 127 c79 79 135 128 148 128 11 0 55 -12 97 -26z m-1798 -1783 c174 -79 354 -248 436 -409 59 -116 72 -104 -213 -196 l-248 -80 -104 104 c-58 58 -105 109 -105 115 0 23 154 495 162 495 5 0 37 -13 72 -29z"/></g></svg>`
        editButton.addEventListener("click", () => {
            let editData = fs.readFileSync(`${src}.json`, "utf8")
            editData = JSON.parse(editData)
            window.pitchEditor = editData.pitchEditor
            dialogueInput.value = editData.inputSequence
            setPitchEditorValues(undefined, undefined, undefined, true)
            pace_slid.value = editData.pacing

            if (samplePlay.style.display!="none") {
                samplePlay.removeChild(samplePlay.children[0])
                samplePlay.appendChild(createElem("audio", {controls: true}, createElem("source", {
                    src: src,
                    type: `audio/${fileFormat}`
                })))
            }
        })
        audioControls.appendChild(editButton)
    }

    const renameButton = createElem("div", {title: window.i18n.RENAME_THE_FILE})
    renameButton.innerHTML = `<svg class="renameSVG" version="1.0" xmlns="http://www.w3.org/2000/svg" width="166.000000pt" height="336.000000pt" viewBox="0 0 166.000000 336.000000" preserveAspectRatio="xMidYMid meet"><g transform="translate(0.000000,336.000000) scale(0.100000,-0.100000)" fill="#000000" stroke="none"> <path d="M165 3175 c-30 -31 -35 -42 -35 -84 0 -34 6 -56 21 -75 42 -53 58 -56 324 -56 l245 0 0 -1290 0 -1290 -245 0 c-266 0 -282 -3 -324 -56 -15 -19 -21 -41 -21 -75 0 -42 5 -53 35 -84 l36 -35 281 0 280 0 41 40 c30 30 42 38 48 28 5 -7 9 -16 9 -21 0 -4 15 -16 33 -27 30 -19 51 -20 319 -20 l287 0 36 35 c30 31 35 42 35 84 0 34 -6 56 -21 75 -42 53 -58 56 -324 56 l-245 0 0 1290 0 1290 245 0 c266 0 282 3 324 56 15 19 21 41 21 75 0 42 -5 53 -35 84 l-36 35 -287 0 c-268 0 -289 -1 -319 -20 -18 -11 -33 -23 -33 -27 0 -5 -4 -14 -9 -21 -6 -10 -18 -2 -48 28 l-41 40 -280 0 -281 0 -36 -35z"/></g></svg>`

    renameButton.addEventListener("click", () => {
        createModal("prompt", {
            prompt: window.i18n.ENTER_NEW_FILENAME_UNCHANGED_CANCEL,
            value: sample.querySelector("div").innerHTML
        }).then(newFileName => {
            if (newFileName!=fileName) {
                const oldPath = src.split("/").reverse()
                const newPath = src.split("/").reverse()
                oldPath[0] = sample.querySelector("div").innerHTML
                newPath[0] = newFileName

                const oldPathComposed = oldPath.reverse().join("/")
                const newPathComposed = newPath.reverse().join("/")
                fs.renameSync(oldPathComposed, newPathComposed)

                if (fs.existsSync(`${oldPathComposed}.json`)) {
                    fs.renameSync(oldPathComposed+".json", newPathComposed+".json")
                }

                sample.querySelector("div").innerHTML = newFileName
                if (samplePlay.style.display!="none") {
                    samplePlay.removeChild(samplePlay.children[0])
                    samplePlay.appendChild(createElem("audio", {controls: true}, createElem("source", {
                        src: newPathComposed,
                        type: `audio/${fileFormat}`
                    })))
                }
            }
        })
    })

    const editInProgramButton = createElem("div", {title: window.i18n.EDIT_IN_EXTERNAL_PROGRAM})
    editInProgramButton.innerHTML = `<svg class="renameSVG" version="1.0" width="175.000000pt" height="240.000000pt" viewBox="0 0 175.000000 240.000000"  preserveAspectRatio="xMidYMid meet"><g transform="translate(0.000000,240.000000) scale(0.100000,-0.100000)" fill="#000000" stroke="none"><path d="M615 2265 l-129 -125 -68 0 c-95 0 -98 -4 -98 -150 0 -146 3 -150 98 -150 l68 0 129 -125 c128 -123 165 -145 179 -109 8 20 8 748 0 768 -14 36 -51 14 -179 -109z"/> <path d="M1016 2344 c-22 -21 -20 -30 10 -51 66 -45 126 -109 151 -162 22 -47 27 -69 27 -141 0 -72 -5 -94 -27 -141 -25 -53 -85 -117 -151 -162 -30 -20 -33 -39 -11 -57 22 -18 64 3 132 64 192 173 164 491 -54 636 -54 35 -56 35 -77 14z"/> <path d="M926 2235 c-8 -22 1 -37 46 -70 73 -53 104 -149 78 -241 -13 -44 -50 -92 -108 -136 -26 -21 -27 -31 -6 -52 37 -38 150 68 179 167 27 91 13 181 -41 259 -49 70 -133 112 -148 73z"/> <path d="M834 2115 c-9 -23 2 -42 33 -57 53 -25 56 -108 4 -134 -35 -18 -44 -30 -36 -53 8 -25 34 -27 76 -6 92 48 92 202 0 250 -38 19 -70 19 -77 0z"/> <path d="M1381 1853 c-33 -47 -182 -253 -264 -364 -100 -137 -187 -262 -187 -270 0 -8 140 -204 177 -249 5 -6 41 41 109 141 30 45 60 86 65 93 48 54 197 276 226 336 33 68 37 83 37 160 1 71 -3 93 -23 130 -53 101 -82 106 -140 23z"/> <path d="M211 1861 c-56 -60 -68 -184 -27 -283 15 -38 106 -168 260 -371 130 -173 236 -320 236 -328 0 -8 -9 -25 -20 -39 -11 -14 -20 -29 -20 -33 0 -5 -10 -23 -23 -40 -12 -18 -27 -41 -33 -52 -13 -24 -65 -114 -80 -138 -10 -17 -13 -16 -60 7 -98 49 -209 43 -305 -17 -83 -51 -129 -141 -129 -251 0 -161 115 -283 275 -294 101 -6 173 22 243 96 56 58 79 97 133 227 46 112 101 203 164 274 l53 60 42 -45 c27 -29 69 -103 124 -217 86 -176 133 -250 197 -306 157 -136 405 -73 478 123 37 101 21 202 -46 290 -91 118 -275 147 -402 63 -30 -20 -42 -23 -49 -14 -5 7 -48 82 -96 167 -47 85 -123 202 -168 260 -45 58 -111 143 -146 190 -85 110 -251 326 -321 416 -31 40 -65 84 -76 100 -11 15 -35 46 -54 68 -19 23 -45 58 -59 79 -30 45 -54 47 -91 8z m653 -943 c20 -28 20 -33 0 -52 -42 -43 -109 10 -69 54 24 26 50 25 69 -2z m653 -434 c49 -20 87 -85 87 -149 -2 -135 -144 -209 -257 -134 -124 82 -89 265 58 299 33 8 64 4 112 -16z m-1126 -20 c47 -24 73 -71 77 -139 3 -50 0 -65 -20 -94 -34 -50 -71 -73 -125 -78 -99 -9 -173 53 -181 152 -11 135 126 223 249 159z"/></g></svg>`
    editInProgramButton.addEventListener("click", () => {

        if (window.userSettings.externalAudioEditor && window.userSettings.externalAudioEditor.length) {
            const fileName = audio.children[0].src.split("file:///")[1].split("%20").join(" ")
            const sp = spawn(window.userSettings.externalAudioEditor, [fileName], {'detached': true}, (err, data) => {
                if (err) {
                    console.log(err)
                    console.log(err.message)
                    window.errorModal(err.message)
                }
            })

            sp.on("error", err => {
                if (err.message.includes("ENOENT")) {
                    window.errorModal(`${window.i18n.FOLLOWING_PATH_NOT_VALID}:<br><br> ${window.userSettings.externalAudioEditor}`)
                } else {
                    window.errorModal(err.message)
                }
            })

        } else {
            window.errorModal(window.i18n.SPECIFY_EDIT_TOOL)
        }
    })


    const deleteFileButton = createElem("div", {title: window.i18n.DELETE_FILE})
    deleteFileButton.innerHTML = "&#10060;"
    deleteFileButton.addEventListener("click", () => {
        confirmModal(`${window.i18n.SURE_DELETE}<br><br><i>${fileName}</i>`).then(confirmation => {
            if (confirmation) {
                window.appLogger.log(`${newSample?window.i18n.DELETING_NEW_FILE:window.i18n.DELETING}: ${src}`)
                fs.unlinkSync(src)
                sample.remove()
                if (fs.existsSync(`${src}.json`)) {
                    fs.unlinkSync(`${src}.json`)
                }
            }
        })
    })
    audioControls.appendChild(renameButton)
    audioControls.appendChild(audio)
    audioControls.appendChild(editInProgramButton)
    audioControls.appendChild(openFileLocationButton)
    audioControls.appendChild(deleteFileButton)
    sample.appendChild(audioControls)
    return sample
}


generateVoiceButton.addEventListener("click", () => {

    const game = window.currentGame[0]

    try {fs.mkdirSync(window.userSettings[`outpath_${game}`])} catch (e) {/*Do nothing*/}
    try {fs.mkdirSync(`${window.userSettings[`outpath_${game}`]}/${voiceId}`)} catch (e) {/*Do nothing*/}


    if (generateVoiceButton.dataset.modelQuery && generateVoiceButton.dataset.modelQuery!="null") {

        if (window.batch_state.state) {
            window.errorModal(window.i18n.BATCH_ERR_IN_PROGRESS)
            return
        }

        window.appLogger.log(`${window.i18n.LOADING_VOICE}: ${JSON.parse(generateVoiceButton.dataset.modelQuery).model}`)
        window.batch_state.lastModel = JSON.parse(generateVoiceButton.dataset.modelQuery).model.split("/").reverse()[0]

        spinnerModal(`${window.i18n.LOADING_VOICE}`)
        fetch(`http://localhost:8008/loadModel`, {
            method: "Post",
            body: generateVoiceButton.dataset.modelQuery
        }).then(r=>r.text()).then(res => {
            generateVoiceButton.dataset.modelQuery = null
            generateVoiceButton.innerHTML = window.i18n.GENERATE_VOICE
            generateVoiceButton.dataset.modelIDLoaded = generateVoiceButton.dataset.modelIDToLoad

            if (window.userSettings.defaultToHiFi && window.currentModel.hifi) {
                vocoder_select.value = Array.from(vocoder_select.children).find(opt => opt.innerHTML=="Bespoke HiFi GAN").value
                changeVocoder(vocoder_select.value)
            } else if (window.userSettings.vocoder.includes(".hg.pt")) {
                changeVocoder("qnd")
            } else {
                closeModal()
            }
        }).catch(e => {
            console.log(e)
            if (e.code =="ENOENT") {
                closeModal(null, modalContainer).then(() => {
                    createModal("error", window.i18n.ERR_SERVER)
                })
            }
        })
    } else {

        if (isGenerating) {
            return
        }

        const sequence = dialogueInput.value.trim().replace("…", "...")
        if (sequence.length==0) {
            return
        }
        isGenerating = true

        const existingSample = samplePlay.querySelector("audio")
        if (existingSample) {
            existingSample.pause()
        }

        toggleSpinnerButtons()

        const voiceType = title.dataset.modelId
        const outputFileName = dialogueInput.value.slice(0, 260).replace(/\n/g, " ").replace(/[\/\\:\*?<>"|]*/g, "")

        try {fs.unlinkSync(localStorage.getItem("tempFileLocation"))} catch (e) {/*Do nothing*/}

        // For some reason, the samplePlay audio element does not update the source when the file name is the same
        const tempFileNum = `${Math.random().toString().split(".")[1]}`
        const tempFileLocation = `${path}/output/temp-${tempFileNum}.wav`
        let pitch = []
        let duration = []
        let isFreshRegen = true
        let old_sequence = undefined

        if (editor.innerHTML && editor.innerHTML.length && generateVoiceButton.dataset.modelIDLoaded==window.pitchEditor.currentVoice) {
            if (window.pitchEditor.audioInput || window.pitchEditor.sequence && sequence!=window.pitchEditor.inputSequence) {
                old_sequence = window.pitchEditor.inputSequence
            }
        }

        if (editor.innerHTML && editor.innerHTML.length && (window.userSettings.keepEditorOnVoiceChange || generateVoiceButton.dataset.modelIDLoaded==window.pitchEditor.currentVoice)) {
            pitch = window.pitchEditor.pitchNew.map(v=> v==undefined?0:v)
            duration = window.pitchEditor.dursNew.map(v => v*pace_slid.value).map(v=> v==undefined?0:v)
            isFreshRegen = false
        }
        window.pitchEditor.currentVoice = generateVoiceButton.dataset.modelIDLoaded

        const speaker_i = window.currentModel.games[0].emb_i
        const pace = (window.userSettings.keepPaceOnNew && isFreshRegen)?pace_slid.value:1


        window.appLogger.log(`${window.i18n.SYNTHESIZING}: ${sequence}`)

        fetch(`http://localhost:8008/synthesize`, {
            method: "Post",
            body: JSON.stringify({
                sequence, pitch, duration, speaker_i, pace,
                old_sequence, // For partial re-generation
                outfile: tempFileLocation,
                vocoder: window.userSettings.vocoder
            })
        }).then(r=>r.text()).then(res => {
            isGenerating = false
            res = res.split("\n")
            let pitchData = res[0]
            let durationsData = res[1]
            let cleanedSequence = res[2]
            pitchData = pitchData.split(",").map(v => parseFloat(v))
            durationsData = durationsData.split(",").map(v => isFreshRegen ? parseFloat(v) : parseFloat(v)/pace_slid.value)
            window.pitchEditor.inputSequence = sequence
            window.pitchEditor.sequence = cleanedSequence

            if (pitch.length==0 || isFreshRegen) {
                window.pitchEditor.ampFlatCounter = 0
                window.pitchEditor.resetPitch = pitchData
                window.pitchEditor.resetDurs = durationsData
            }

            setPitchEditorValues(cleanedSequence.replace(/\s/g, "_").split(""), pitchData, durationsData, isFreshRegen, pace)

            toggleSpinnerButtons()
            keepSampleButton.dataset.newFileLocation = `${window.userSettings[`outpath_${game}`]}/${voiceType}/${outputFileName}.wav`
            keepSampleButton.disabled = false
            samplePlay.dataset.tempFileLocation = tempFileLocation
            samplePlay.innerHTML = ""

            const finalOutSrc = `./output/temp-${tempFileNum}.wav`.replace("..", ".")

            const audio = createElem("audio", {controls: true, style: {width:"150px"}},
                    createElem("source", {src: finalOutSrc, type: "audio/wav"}))
            samplePlay.appendChild(audio)
            audio.load()
            if (window.userSettings.autoPlayGen) {
                audio.play()
            }

            // Persistance across sessions
            localStorage.setItem("tempFileLocation", tempFileLocation)
        }).catch(res => {
            isGenerating = false
            console.log(res)
            window.errorModal(window.i18n.SOMETHING_WENT_WRONG)
            toggleSpinnerButtons()
        })
    }
})

const saveFile = (from, to) => {
    to = to.split("%20").join(" ")
    to = to.replace(".wav", `.${window.userSettings.audio.format}`)

    // Make the containing folder if it does not already exist
    let containerFolderPath = to.split("/")
    containerFolderPath = containerFolderPath.slice(0,containerFolderPath.length-1).join("/")

    try {fs.mkdirSync(containerFolderPath)} catch (e) {/*Do nothing*/}

    // For plugins
    const pluginData = {
        game: window.currentGame[0],
        voiceId: window.currentModel.voiceId,
        voiceName: window.currentModel.voiceName,
        inputSequence: window.pitchEditor.inputSequence,
        letters: window.pitchEditor.letters,
        pitch: window.pitchEditor.pitchNew,
        durations: window.pitchEditor.dursNew,
        vocoder: vocoder_select.value,
        from, to
    }
    const options = {
        hz: window.userSettings.audio.hz,
        padStart: window.userSettings.audio.padStart,
        padEnd: window.userSettings.audio.padEnd,
        bit_depth: window.userSettings.audio.bitdepth,
        amplitude: window.userSettings.audio.amplitude
    }
    pluginData.audioOptions = options
    window.pluginsManager.runPlugins(window.pluginsManager.pluginsModules["keep-sample"]["pre"], event="pre keep-sample", pluginData)

    if (window.userSettings.audio.ffmpeg) {
        spinnerModal(window.i18n.SAVING_AUDIO_FILE)

        window.appLogger.log(`${window.i18n.ABOUT_TO_SAVE_FROM_N1_TO_N2_WITH_OPTIONS}: ${JSON.stringify(options)}`.replace("_1", from).replace("_2", to))

        const extraInfo = {
            game: window.currentGame[0],
            voiceId: window.currentModel.voiceId,
            voiceName: window.currentModel.voiceName
        }

        fetch(`http://localhost:8008/outputAudio`, {
            method: "Post",
            body: JSON.stringify({
                input_path: from,
                output_path: to,
                extraInfo: JSON.stringify(pluginData),
                options: JSON.stringify(options)
            })
        }).then(r=>r.text()).then(res => {
            closeModal().then(() => {
                if (res.length) {
                    console.log("res", res)
                    window.errorModal(`${window.i18n.SOMETHING_WENT_WRONG}<br><br>${window.i18n.INPUT}: ${from}<br>${window.i18n.OUTPUT}: ${to}<br><br>${res}`)
                } else {
                    if (window.userSettings.outputJSON) {
                        fs.writeFileSync(`${to}.json`, JSON.stringify({inputSequence: dialogueInput.value.trim(), pitchEditor: window.pitchEditor, pacing: parseFloat(pace_slid.value)}, null, 4))
                    }
                    voiceSamples.appendChild(makeSample(to, true))
                    window.pluginsManager.runPlugins(window.pluginsManager.pluginsModules["keep-sample"]["post"], event="post keep-sample", pluginData)
                }
            })
        }).catch(res => {
            window.appLogger.log(res)
            closeModal().then(() => {
                window.errorModal(`${window.i18n.SOMETHING_WENT_WRONG}<br><br>${window.i18n.INPUT}: ${from}<br>${window.i18n.OUTPUT}: ${to}<br><br>${res}`)
            })
        })
    } else {
        fs.copyFile(from, to, err => {
            if (err) {
                console.log(err)
                window.appLogger.log(err)
                if (!fs.existsSync(from)) {
                    window.appLogger.log(`${window.i18n.TEMP_FILE_NOT_EXIST}: ${from}`)
                }
                const outputFolder = to.split("/").reverse().slice(1,1000).reverse().join("/")
                if (!fs.existsSync(outputFolder)) {
                    window.appLogger.log(`${window.i18n.OUT_DIR_NOT_EXIST}: ${outputFolder}`)
                }
            } else {
                if (window.userSettings.outputJSON) {
                    fs.writeFileSync(`${to}.json`, JSON.stringify({inputSequence: dialogueInput.value.trim(), pitchEditor: window.pitchEditor, pacing: parseFloat(pace_slid.value)}, null, 4))
                }
                voiceSamples.appendChild(makeSample(to, true))
                window.pluginsManager.runPlugins(window.pluginsManager.pluginsModules["keep-sample"]["post"], event="post keep-sample", pluginData)
            }
        })
    }
}

window.keepSampleFunction = shiftClick => {
    if (keepSampleButton.dataset.newFileLocation) {

        let fromLocation = samplePlay.dataset.tempFileLocation
        let toLocation = keepSampleButton.dataset.newFileLocation

        toLocation = toLocation.split("/")
        toLocation[toLocation.length-1] = toLocation[toLocation.length-1].replace(/[\/\\:\*?<>"|]*/g, "")
        toLocation[toLocation.length-1] = toLocation[toLocation.length-1].replace(/\.wav$/, "").slice(0, 75).replace(/\.$/, "")


        // Numerical file name counter
        if (window.userSettings.filenameNumericalSeq) {
            let existingFiles = []
            try {
                existingFiles = fs.readdirSync(toLocation.slice(0, toLocation.length-1).join("/")).filter(fname => !fname.endsWith(".json"))
            } catch (e) {
            }
            existingFiles = existingFiles.filter(fname => fname.includes(toLocation[toLocation.length-1]))
            existingFiles = existingFiles.map(fname => {
                const parts = fname.split(".")
                if (parts.length>2 && parts[parts.length-2].length) {
                    if (parseInt(parts[parts.length-2]) != NaN) {
                        return parseInt(parts[parts.length-2])
                    }
                }
                return null
            })
            existingFiles = existingFiles.filter(val => !!val)
            if (existingFiles.length==0) {
                existingFiles.push(0)
            }

            if (existingFiles.length) {
                existingFiles = existingFiles.sort((a,b) => {a<b?-1:1})
                toLocation[toLocation.length-1] = `${toLocation[toLocation.length-1]}.${String(existingFiles[existingFiles.length-1]+1).padStart(4, "0")}`
            }
        }


        toLocation[toLocation.length-1] += ".wav"
        toLocation = toLocation.join("/")


        const outFolder = toLocation.split("/").reverse().slice(2, 100).reverse().join("/")
        if (!fs.existsSync(outFolder)) {
            return void window.errorModal(`${window.i18n.OUT_DIR_NOT_EXIST}:<br><br><i>${outFolder}</i><br><br>${window.i18n.YOU_CAN_CHANGE_IN_SETTINGS}`)
        }

        // File name conflict
        const alreadyExists = fs.existsSync(toLocation)
        if (alreadyExists || shiftClick) {

            const promptText = alreadyExists ? window.i18n.FILE_EXISTS_ADJUST : window.i18n.ENTER_FILE_NAME

            createModal("prompt", {
                prompt: promptText,
                value: toLocation.split("/").reverse()[0].replace(".wav", `.${window.userSettings.audio.format}`)
            }).then(newFileName => {

                let toLocationOut = toLocation.split("/").reverse()
                toLocationOut[0] = newFileName.replace(`.${window.userSettings.audio.format}`, "") + `.${window.userSettings.audio.format}`
                let outDir = toLocationOut
                outDir.shift()

                newFileName = (newFileName.replace(`.${window.userSettings.audio.format}`, "") + `.${window.userSettings.audio.format}`).replace(/[\/\\:\*?<>"|]*/g, "")
                toLocationOut.reverse()
                toLocationOut.push(newFileName)

                if (fs.existsSync(outDir.slice(0, outDir.length-1).join("/"))) {
                    const existingFiles = fs.readdirSync(outDir.slice(0, outDir.length-1).join("/"))
                    const existingFileConflict = existingFiles.filter(name => name==newFileName)


                    const finalOutLocation = toLocationOut.join("/")

                    if (existingFileConflict.length) {
                        // Remove the entry from the output files' preview
                        Array.from(voiceSamples.querySelectorAll("div.sample")).forEach(sampleElem => {
                            const source = sampleElem.querySelector("source")
                            let sourceSrc = source.src.split("%20").join(" ").replace("file:///", "")
                            sourceSrc = sourceSrc.split("/").reverse()
                            const finalFileName = finalOutLocation.split("/").reverse()

                            if (sourceSrc[0] == finalFileName[0]) {
                                sampleElem.parentNode.removeChild(sampleElem)
                            }
                        })

                        // Remove the old file and write the new one in
                        fs.unlink(finalOutLocation, err => {
                            if (err) {
                                console.log(err)
                                window.appLogger.log(err)
                            }
                            console.log(fromLocation, "finalOutLocation", finalOutLocation)
                            saveFile(fromLocation, finalOutLocation)
                        })
                        return
                    } else {
                        saveFile(fromLocation, toLocationOut.join("/"))
                        return
                    }
                }
                saveFile(fromLocation, toLocationOut.join("/"))
            })

        } else {
            saveFile(fromLocation, toLocation)
        }
    }
}
keepSampleButton.addEventListener("click", event => keepSampleFunction(event.shiftKey))





let startingSplashInterval
let loadingStage = 0
let hasRunPostStartPlugins = false
startingSplashInterval = setInterval(() => {
    if (fs.existsSync(`${path}/FASTPITCH_LOADING`)) {
        if (loadingStage==0) {
            spinnerModal(`${window.i18n.LOADING}...<br>${window.i18n.MAY_TAKE_A_MINUTE}<br><br>${window.i18n.BUILDING_FASTPITCH}...`)
            loadingStage = 1
        }
    } else if (fs.existsSync(`${path}/WAVEGLOW_LOADING`)) {
        if (loadingStage==1) {
            activeModal.children[0].innerHTML = `${window.i18n.LOADING}...<br>${window.i18n.MAY_TAKE_A_MINUTE}<br><br>${window.i18n.LOADING_WAVEGLOW}...`
            loadingStage = 2
        }
    } else if (fs.existsSync(`${path}/SERVER_STARTING`)) {
        if (loadingStage==2) {
            activeModal.children[0].innerHTML = `${window.i18n.LOADING}...<br>${window.i18n.MAY_TAKE_A_MINUTE}<br><br>${window.i18n.STARTING_PYTHON}...`
            loadingStage = 3
        }
    } else {
        closeModal().then(() => {
            clearInterval(startingSplashInterval)
            if (!hasRunPostStartPlugins) {
                hasRunPostStartPlugins = true
                window.pluginsManager.runPlugins(window.pluginsManager.pluginsModules["start"]["post"], event="post start")
            }
        })
    }
}, 100)




modalContainer.addEventListener("click", event => {
    if (event.target==modalContainer && activeModal.dataset.type!="spinner") {
        closeModal()
    }
})

dialogueInput.addEventListener("keyup", () => {
    localStorage.setItem("dialogueInput", dialogueInput.value)
    window.pitchEditor.hasChanged = true
})

const dialogueInputCache = localStorage.getItem("dialogueInput")

if (dialogueInputCache) {
    dialogueInput.value = dialogueInputCache
}




// Pitch/Duration editor
// =====================

window.setLetterFocus = (l, multi) => {
    if (window.pitchEditor.letterFocus.length && !multi) {
        window.pitchEditor.letterFocus.forEach(li => letterElems[li].style.color = "black")
        window.pitchEditor.letterFocus = []
    }
    window.pitchEditor.letterFocus.push(l)
    window.pitchEditor.letterFocus = Array.from(new Set(window.pitchEditor.letterFocus.sort()))
    window.pitchEditor.letterFocus.forEach(li => letterElems[li].style.color = "red")

    if (window.pitchEditor.letterFocus.length==1) {
        letterLength.value = parseFloat(window.pitchEditor.dursNew[window.pitchEditor.letterFocus[0]])
        letterPitchNumb.value = parseFloat(window.pitchEditor.pitchNew[window.pitchEditor.letterFocus[0]]*1000)/1000
        letterLengthNumb.value = letterLength.value

        letterLength.disabled = false
        letterPitchNumb.disabled = false
        letterLengthNumb.disabled = false
    } else {
        letterPitchNumb.disabled = true
        letterPitchNumb.value = ""
        letterLengthNumb.disabled = true
        letterLengthNumb.value = ""
    }
}

let sliders = []
let letterElems = []
let autoinfer_timer = null
let has_been_changed = false
let css_hack_items = []
let elemsWidths = []
const infer = () => {
    has_been_changed = false
    if (!isGenerating) {
        generateVoiceButton.click()
    }
}
const set_letter_display = (elem, elem_i, length=null, value=null) => {
    if (length != null && elem) {
        const elem_length = length/2
        elem.style.width = `${parseInt(elem_length/2)}px`
        elem.children[1].style.height = `${elem_length}px`
        elem.children[1].style.marginTop = `${-parseInt(elem_length/2)+90}px`
        css_hack_items[elem_i].innerHTML = `#slider_${elem_i}::-webkit-slider-thumb {height: ${elem_length}px;}`
        elemsWidths[elem_i] = elem_length
        elem.style.paddingLeft = `${parseInt(elem_length/2)}px`
        editor.style.width = `${parseInt(elemsWidths.reduce((p,c)=>p+c,1)*1.25)}px`
    }

    if (value != null) {
        elem.children[1].value = value
    }
}
const setPitchEditorValues = (letters, pitchOrig, lengthsOrig, isFreshRegen, pace=1) => {

    Array.from(editor.children).forEach(child => editor.removeChild(child))

    letters = letters ? letters : window.pitchEditor.letters
    pitchOrig = pitchOrig ? pitchOrig : window.pitchEditor.pitchNew
    lengthsOrig = lengthsOrig ? lengthsOrig : window.pitchEditor.dursNew

    if (isFreshRegen) {
        window.pitchEditor.letterFocus = []
        pace_slid.value = pace
        paceNumbInput.value = pace
    }

    window.pitchEditor.letters = letters
    window.pitchEditor.pitchNew = pitchOrig.map(p=>p)
    window.pitchEditor.dursNew = lengthsOrig.map(v=>v)

    sliders = []
    letterElems = []
    autoinfer_timer = null
    has_been_changed = false
    css_hack_items = []
    elemsWidths = []

    letters.forEach((letter, l) => {

        const letterLabel = createElem("div.letterElem", letter)
        const letterDiv = createElem("div.letter", letterLabel)
        const slider = createElem(`input.slider#slider_${l}`, {
            type: "range",
            orient: "vertical",
            step: 0.01,
            min: -3,
            max:  3,
            value: pitchOrig[l]
        })
        sliders.push(slider)
        letterDiv.appendChild(slider)

        letterLabel.addEventListener("click", event => setLetterFocus(l, event.ctrlKey))
        let multiLetterPitchDelta = undefined
        let multiLetterStartPitchVals = []
        slider.addEventListener("mousedown", () => {
            if (window.pitchEditor.letterFocus.length <= 1 || (!event.ctrlKey && !window.pitchEditor.letterFocus.includes(l))) {
                setLetterFocus(l)
            }

            if (window.pitchEditor.letterFocus.length>1) {
                multiLetterPitchDelta = slider.value
                multiLetterStartPitchVals = sliders.map(slider => parseFloat(slider.value))
            }

            // Tooltip
            if (window.userSettings.sliderTooltip) {
                const sliderRect = slider.getClientRects()[0]
                editorTooltip.style.display = "flex"
                const tooltipRect = editorTooltip.getClientRects()[0]
                editorTooltip.style.left = `${parseInt(sliderRect.left)-parseInt(tooltipRect.width) - 15}px`
                editorTooltip.style.top = `${parseInt(sliderRect.top)+parseInt(sliderRect.height/2) - parseInt(tooltipRect.height*0.75)}px`
                editorTooltip.innerHTML = slider.value
            }
        })
        slider.addEventListener("mouseup", () => editorTooltip.style.display = "none")
        slider.addEventListener("input", () => {
            editorTooltip.innerHTML = slider.value

            if (window.pitchEditor.letterFocus.length>1) {
                window.pitchEditor.letterFocus.forEach(li => {
                    if (li!=l) {
                        sliders[li].value = multiLetterStartPitchVals[li]+(slider.value-multiLetterPitchDelta)
                    }
                    window.pitchEditor.pitchNew[li] = parseFloat(sliders[li].value)
                })
            } else if (window.pitchEditor.letterFocus.length==1) {
                letterPitchNumb.value = slider.value
            }
        })


        slider.addEventListener("change", () => {
            if (window.pitchEditor.letterFocus.length==1) {
                window.pitchEditor.pitchNew[l] = parseFloat(slider.value)
                letterPitchNumb.value = slider.value
            }
            has_been_changed = true
            if (autoplay_ckbx.checked) {
                generateVoiceButton.click()
            }
            editorTooltip.style.display = "none"
        })

        if (window.pitchEditor.letterFocus.includes(l)) {
            letterDiv.style.color = "red"
        }


        let length = window.pitchEditor.dursNew[l] * pace_slid.value * 10 + 50

        letterDiv.style.width = `${parseInt(length/2)}px`
        slider.style.height = `${length}px`

        slider.style.marginLeft = `${-100}px`
        letterDiv.style.paddingLeft = `${parseInt(length/2)}px`

        const css_hack_elem = createElem("style", `#slider_${l}::-webkit-slider-thumb {height: ${length}px;}`)
        css_hack_items.push(css_hack_elem)
        css_hack_pitch_editor.appendChild(css_hack_elem)
        elemsWidths.push(length)
        editor.style.width = `${parseInt(elemsWidths.reduce((p,c)=>p+c,1)*1.15)}px`

        editor.appendChild(letterDiv)
        letterElems.push(letterDiv)

        set_letter_display(letterDiv, l, length, pitchOrig[l])
    })
}

// Un-select letters when clicking anywhere else
right.addEventListener("click", event => {
    if (event.target.nodeName=="BUTTON" || event.target.nodeName=="INPUT" || event.target.nodeName=="SVG" || event.target.nodeName=="IMG" || event.target.nodeName=="path" ||
        ["letterElem", "infoContainer"].includes(event.target.className)) {
        return
    }

    window.pitchEditor.letterFocus = []
    letterElems.forEach((letterDiv, l) => {
        letterDiv.style.color = "black"
    })
    letterPitchNumb.disabled = true
    letterPitchNumb.value = ""
    letterLength.disabled = true
    letterLengthNumb.disabled = true
    letterLengthNumb.value = ""
})

letterPitchNumb.addEventListener("input", () => {
    const lpnValue = parseFloat(letterPitchNumb.value) || 0
    if (window.pitchEditor.pitchNew[window.pitchEditor.letterFocus[0]]!=lpnValue) {
        has_been_changed = true
    }
    window.pitchEditor.pitchNew[window.pitchEditor.letterFocus[0]] = lpnValue
    sliders[window.pitchEditor.letterFocus[0]].value = letterPitchNumb.value
    if (autoplay_ckbx.checked) {
        generateVoiceButton.click()
    }
})
letterPitchNumb.addEventListener("change", () => {
    const lpnValue = parseFloat(letterPitchNumb.value) || 0
    if (window.pitchEditor.pitchNew[window.pitchEditor.letterFocus[0]]!=lpnValue) {
        has_been_changed = true
    }
    window.pitchEditor.pitchNew[window.pitchEditor.letterFocus[0]] = lpnValue
    sliders[window.pitchEditor.letterFocus[0]].value = letterPitchNumb.value
    if (autoplay_ckbx.checked) {
        generateVoiceButton.click()
    }
})

resetLetter_btn.addEventListener("click", () => {
    if (window.pitchEditor.letterFocus.length==0) {
        return
    }

    window.pitchEditor.letterFocus.forEach(l => {
        if (window.pitchEditor.dursNew[l] != window.pitchEditor.resetDurs[l]) {
            has_been_changed = true
        }
        window.pitchEditor.dursNew[l] = window.pitchEditor.resetDurs[l]
        window.pitchEditor.pitchNew[l] = window.pitchEditor.resetPitch[l]
        set_letter_display(letterElems[l], l, window.pitchEditor.resetDurs[l]* pace_slid.value*10+50, window.pitchEditor.pitchNew[l])
    })

    if (window.pitchEditor.letterFocus.length==1) {
        letterLength.value = parseFloat(window.pitchEditor.dursNew[window.pitchEditor.letterFocus[0]])
        letterLengthNumb.value = parseFloat(window.pitchEditor.dursNew[window.pitchEditor.letterFocus[0]])
        letterPitchNumb.value = parseFloat(window.pitchEditor.pitchNew[window.pitchEditor.letterFocus[0]]*1000)/1000
    }
})
const updateLetterLengthFromInput = () => {
    if (window.pitchEditor.dursNew[window.pitchEditor.letterFocus[0]] != letterLength.value) {
        has_been_changed = true
    }
    window.pitchEditor.dursNew[window.pitchEditor.letterFocus[0]] = parseFloat(letterLength.value)

    window.pitchEditor.letterFocus.forEach(l => {
        const letterElem = letterElems[l]
        const newWidth = window.pitchEditor.dursNew[l] * pace_slid.value //* 100
        set_letter_display(letterElem, l, newWidth * 10 + 50)
    })
}
let multiLetterLengthDelta = undefined
let multiLetterStartLengthVals = []
letterLength.addEventListener("mousedown", () => {
    if (window.pitchEditor.letterFocus.length>1) {
        multiLetterLengthDelta = letterLength.value
        multiLetterStartLengthVals = window.pitchEditor.dursNew.map(v=>v)
    }
})
letterLength.addEventListener("input", () => {
    if (window.pitchEditor.letterFocus.length>1) {
        window.pitchEditor.letterFocus.forEach(li => {
            window.pitchEditor.dursNew[li] = multiLetterStartLengthVals[li]+(parseFloat(letterLength.value)-multiLetterLengthDelta)
        })
        updateLetterLengthFromInput()
        return
    }

    letterLengthNumb.value = letterLength.value
    updateLetterLengthFromInput()

    // Tooltip
    if (window.userSettings.sliderTooltip) {
        const sliderRect = letterLength.getClientRects()[0]
        editorTooltip.style.display = "flex"
        const tooltipRect = editorTooltip.getClientRects()[0]

        editorTooltip.style.left = `${parseInt(sliderRect.left)+parseInt(sliderRect.width/2) - parseInt(tooltipRect.width*0.75)}px`
        editorTooltip.style.top = `${parseInt(sliderRect.top)-parseInt(tooltipRect.height) - 15}px`
        editorTooltip.innerHTML = letterLength.value
    }
})
letterLength.addEventListener("mouseup", () => {
    if (has_been_changed) {
        if (autoinfer_timer != null) {
            clearTimeout(autoinfer_timer)
            autoinfer_timer = null
        }
        if (autoplay_ckbx.checked) {
            autoinfer_timer = setTimeout(infer, 500)
        }
    }
    editorTooltip.style.display = "none"
})
letterLengthNumb.addEventListener("input", () => {
    letterLength.value = letterLengthNumb.value
    updateLetterLengthFromInput()
})
letterLengthNumb.addEventListener("change", () => {
    letterLength.value = letterLengthNumb.value
    updateLetterLengthFromInput()
})

// Reset button
reset_btn.addEventListener("click", () => {
    window.pitchEditor.dursNew = window.pitchEditor.resetDurs
    window.pitchEditor.pitchNew = window.pitchEditor.resetPitch.map(p=>p)
    window.pitchEditor.letters.forEach((_, l) => set_letter_display(letterElems[l], l, window.pitchEditor.resetDurs[l]*10+50, window.pitchEditor.pitchNew[l]))
    letterLength.value = parseFloat(window.pitchEditor.dursNew[window.pitchEditor.letterFocus[0]])
    if (window.pitchEditor.letterFocus.length==1) {
        letterLengthNumb.value = parseFloat(window.pitchEditor.dursNew[window.pitchEditor.letterFocus[0]])
        letterPitchNumb.value = parseFloat(window.pitchEditor.pitchNew[window.pitchEditor.letterFocus[0]]*1000)/1000
    }
    pace_slid.value = 1
})
amplify_btn.addEventListener("click", () => {
    window.pitchEditor.ampFlatCounter += 1
    window.pitchEditor.pitchNew = window.pitchEditor.resetPitch.map((p, pi) => {
        if (window.pitchEditor.letterFocus.length>1 && window.pitchEditor.letterFocus.indexOf(pi)==-1) {
            return p
        }
        const newVal = p*(1+window.pitchEditor.ampFlatCounter*0.025)
        return newVal>0 ? Math.min(3, newVal) : Math.max(-3, newVal)
    })
    window.pitchEditor.letters.forEach((_, l) => set_letter_display(letterElems[l], l, null, window.pitchEditor.pitchNew[l]))
    if (window.pitchEditor.letterFocus.length==1) {
        letterPitchNumb.value = parseFloat(window.pitchEditor.pitchNew[window.pitchEditor.letterFocus[0]]*1000)/1000
    }
})
flatten_btn.addEventListener("click", () => {
    window.pitchEditor.ampFlatCounter -= 1
    window.pitchEditor.pitchNew = window.pitchEditor.resetPitch.map((p,pi) => {
        if (window.pitchEditor.letterFocus.length>1 && window.pitchEditor.letterFocus.indexOf(pi)==-1) {
            return p
        }
        return p*Math.max(0, 1+window.pitchEditor.ampFlatCounter*0.025)
    })
    window.pitchEditor.letters.forEach((_, l) => set_letter_display(letterElems[l], l, null, window.pitchEditor.pitchNew[l]))
    if (window.pitchEditor.letterFocus.length==1) {
        letterPitchNumb.value = parseFloat(window.pitchEditor.pitchNew[window.pitchEditor.letterFocus[0]]*1000)/1000
    }
})
increase_btn.addEventListener("click", () => {
    window.pitchEditor.pitchNew = window.pitchEditor.pitchNew.map((p,pi) => {
        if (window.pitchEditor.letterFocus.length>1 && window.pitchEditor.letterFocus.indexOf(pi)==-1) {
            return p
        }
        return p+0.1
    })
    window.pitchEditor.letters.forEach((_, l) => set_letter_display(letterElems[l], l, null, window.pitchEditor.pitchNew[l]))
    if (window.pitchEditor.letterFocus.length==1) {
        letterPitchNumb.value = parseFloat(window.pitchEditor.pitchNew[window.pitchEditor.letterFocus[0]]*1000)/1000
    }
})
decrease_btn.addEventListener("click", () => {
    window.pitchEditor.pitchNew = window.pitchEditor.pitchNew.map((p,pi) => {
        if (window.pitchEditor.letterFocus.length>1 && window.pitchEditor.letterFocus.indexOf(pi)==-1) {
            return p
        }
        return p-0.1
    })
    window.pitchEditor.letters.forEach((_, l) => set_letter_display(letterElems[l], l, null, window.pitchEditor.pitchNew[l]))
    if (window.pitchEditor.letterFocus.length==1) {
        letterPitchNumb.value = parseFloat(window.pitchEditor.pitchNew[window.pitchEditor.letterFocus[0]]*1000)/1000
    }
})
pace_slid.addEventListener("change", () => {
    editorTooltip.style.display = "none"
    if (autoplay_ckbx.checked) {
        generateVoiceButton.click()
    }
    paceNumbInput.value = pace_slid.value
})

pace_slid.addEventListener("input", () => {
    const new_lengths = window.pitchEditor.dursNew.map((v,l) => v * pace_slid.value)
    window.pitchEditor.letters.forEach((_, l) => set_letter_display(letterElems[l], l, new_lengths[l]* 10 + 50, null))

    // Tooltip
    if (window.userSettings.sliderTooltip) {
        const sliderRect = pace_slid.getClientRects()[0]
        editorTooltip.style.display = "flex"
        const tooltipRect = editorTooltip.getClientRects()[0]

        editorTooltip.style.left = `${parseInt(sliderRect.left)+parseInt(sliderRect.width/2) - parseInt(tooltipRect.width*0.75)}px`
        editorTooltip.style.top = `${parseInt(sliderRect.top)-parseInt(tooltipRect.height) - 15}px`
        editorTooltip.innerHTML = pace_slid.value
    }
})
paceNumbInput.addEventListener("change", () => {
    pace_slid.value = paceNumbInput.value
    if (autoplay_ckbx.checked) {
        generateVoiceButton.click()
    }
})
paceNumbInput.addEventListener("keyup", () => {
    pace_slid.value = paceNumbInput.value
})
autoplay_ckbx.addEventListener("change", () => {
    window.userSettings.autoplay = autoplay_ckbx.checked
    saveUserSettings()
})

// =====================





vocoder_select.value = window.userSettings.vocoder.includes(".hg.") ? "qnd" : window.userSettings.vocoder
const changeVocoder = vocoder => {
    window.userSettings.vocoder = vocoder
    window.batch_state.lastVocoder = vocoder
    spinnerModal(window.i18n.CHANGING_MODELS)
    fetch(`http://localhost:8008/setVocoder`, {
        method: "Post",
        body: JSON.stringify({vocoder})
    }).then(() => {
        closeModal().then(() => {
            saveUserSettings()
        })
    })
}
vocoder_select.addEventListener("change", () => changeVocoder(vocoder_select.value))



// Info
// ====
window.setupModal(infoIcon, infoContainer)


// Patreon
// =======
window.setupModal(patreonIcon, patreonContainer, () => {
    const data = fs.readFileSync(`${path}/patreon.txt`, "utf8")
    const names = new Set()
    data.split("\r\n").forEach(name => names.add(name))
    names.add("minermanb")

    let content = ``
    creditsList.innerHTML = ""
    names.forEach(name => content += `<br>${name}`)
    creditsList.innerHTML = content
})
patreonButton.addEventListener("click", () => {
    shell.openExternal("https://patreon.com")
})
fetch("http://danruta.co.uk/patreon.txt").then(r=>r.text()).then(data => fs.writeFileSync(`${path}/patreon.txt`, data, "utf8"))


// Updates
// =======
app_version.innerHTML = window.appVersion
updatesVersions.innerHTML = `${window.i18n.THIS_APP_VERSION}: ${window.appVersion}`

const checkForUpdates = () => {
    fetch("http://danruta.co.uk/xvasynth_updates.txt").then(r=>r.json()).then(data => {
        fs.writeFileSync(`${path}/updates.json`, JSON.stringify(data), "utf8")
        checkUpdates.innerHTML = window.i18n.CHECK_FOR_UPDATES
        showUpdates()
    }).catch(() => {
        checkUpdates.innerHTML = window.i18n.CANT_REACH_SERVER
    })
}
const showUpdates = () => {
    window.updatesLog = fs.readFileSync(`${path}/updates.json`, "utf8")
    window.updatesLog = JSON.parse(window.updatesLog)
    const sortedLogVersions = Object.keys(window.updatesLog).map( a => a.split('.').map( n => +n+100000 ).join('.') ).sort()
        .map( a => a.split('.').map( n => +n-100000 ).join('.') )

    const appVersion = window.appVersion.replace("v", "")
    const appIsUpToDate = sortedLogVersions.indexOf(appVersion)==(sortedLogVersions.length-1) || sortedLogVersions.indexOf(appVersion)==-1

    if (!appIsUpToDate) {
        update_nothing.style.display = "none"
        update_something.style.display = "block"
        updatesVersions.innerHTML = `${window.i18n.THIS_APP_VERSION}: ${appVersion}. ${window.i18n.AVAILABLE}: ${sortedLogVersions[sortedLogVersions.length-1]}`
    } else {
        updatesVersions.innerHTML = `${window.i18n.THIS_APP_VERSION}: ${appVersion}. ${window.i18n.UPTODATE}`
    }

    updatesLogList.innerHTML = ""
    sortedLogVersions.reverse().forEach(version => {
        const versionLabel = createElem("h2", version)
        const logItem = createElem("div", versionLabel)
        window.updatesLog[version].split("\n").forEach(line => {
            logItem.appendChild(createElem("div", line))
        })
        updatesLogList.appendChild(logItem)
    })
}
checkForUpdates()
window.setupModal(updatesIcon, updatesContainer)

checkUpdates.addEventListener("click", () => {
    checkUpdates.innerHTML = window.i18n.CHECKING_FOR_UPDATES
    checkForUpdates()
})
showUpdates()


// Batch generation
// ========
window.setupModal(batchIcon, batchGenerationContainer)

// Settings
// ========
window.setupModal(settingsCog, settingsContainer)

// Change Game
// ===========
window.setupModal(changeGameButton, gameSelectionContainer)

fs.readdir(`${path}/assets`, (err, fileNames) => {

    let totalVoices = 0
    let totalGames = new Set()

    const itemsToSort = []

    fileNames.filter(fn=>(fn.endsWith(".jpg")||fn.endsWith(".png"))&&fn.split("-").length==4).forEach(fileName => {
        const gameSelection = createElem("div.gameSelection")
        gameSelection.style.background = `url("assets/${fileName}")`

        const gameId = fileName.split("-")[0]
        const gameName = fileName.split("-").reverse()[0].split(".")[0]
        const gameSelectionContent = createElem("div.gameSelectionContent")

        let numVoices = 0
        const modelsPath = window.userSettings[`modelspath_${gameId}`]
        if (fs.existsSync(modelsPath)) {
            const files = fs.readdirSync(modelsPath)
            numVoices = files.filter(fn => fn.includes(".json")).length
            totalVoices += numVoices
        }
        if (numVoices==0) {
            gameSelectionContent.style.background = "rgba(150,150,150,0.7)"
        } else {
            gameSelectionContent.classList.add("gameSelectionContentToHover")
            totalGames.add(gameId)
        }

        gameSelectionContent.appendChild(createElem("div", `${numVoices} ${(numVoices>1||numVoices==0)?window.i18n.VOICE_PLURAL:window.i18n.VOICE}`))
        gameSelectionContent.appendChild(createElem("div", gameName))

        gameSelection.appendChild(gameSelectionContent)

        gameSelectionContent.addEventListener("click", () => {
            changeGame(fileName)
            closeModal(gameSelectionContainer)
        })

        itemsToSort.push([numVoices, gameSelection])

        const modelsDir = window.userSettings[`modelspath_${gameId}`]
        if (!window.watchedModelsDirs.includes(modelsDir)) {
            window.watchedModelsDirs.push(modelsDir)

            try {
                fs.watch(modelsDir, {recursive: false, persistent: true}, (eventType, filename) => {
                    if (window.userSettings.autoReloadVoices) {
                        window.appLogger.log(`${eventType}: ${filename}`)
                        loadAllModels().then(() => changeGame(fileName))
                    }
                })
            } catch (e) {}
        }
    })

    itemsToSort.sort((a,b) => a[0]<b[0]?1:-1).forEach(([numVoices, elem]) => {
        gameSelectionListContainer.appendChild(elem)
    })

    searchGameInput.addEventListener("keyup", () => {
        const voiceElems = Array.from(gameSelectionListContainer.children)
        if (searchGameInput.value.length) {
            voiceElems.forEach(elem => {
                if (elem.children[0].children[1].innerHTML.toLowerCase().includes(searchGameInput.value)) {
                    elem.style.display="flex"
                } else {
                    elem.style.display="none"
                }
            })

        } else {
            voiceElems.forEach(elem => elem.style.display="block")
        }
    })

    searchGameInput.placeholder = window.i18n.SEARCH_N_GAMES_WITH_N2_VOICES.replace("_1", Array.from(totalGames).length).replace("_2", totalVoices)
})



// Plugins
// =======
window.setupModal(pluginsIcon, pluginsContainer)

// Speech-to-Speech
// ================
window.setupModal(s2s_selectVoiceBtn, s2sSelectContainer, () => window.populateS2SVoiceList())
window.setupModal(s2s_settingsRecNoiseBtn, s2sSelectContainer, () => window.populateS2SVoiceList())




// Other
// =====
if (fs.existsSync(`${path}/models/nvidia_waveglowpyt_fp32_20190427.pt`)) {
    loadAllModels().then(() => {
        // Load the last selected game
        const lastGame = localStorage.getItem("lastGame")

        if (lastGame) {
            changeGame(lastGame)
        }
    })
} else {
    setTimeout(() => {
        window.errorModal(window.i18n.WAVEGLOW_NOT_FOUND)
    }, 1500)
}

voiceSearchInput.addEventListener("keyup", () => {
    const voiceElems = Array.from(voiceTypeContainer.children)
    if (voiceSearchInput.value.length) {
        voiceElems.forEach(elem => {
            if (elem.innerHTML.toLowerCase().includes(voiceSearchInput.value)) {
                elem.style.display="block"
            } else {
                elem.style.display="none"
            }
        })

    } else {
        voiceElems.forEach(elem => elem.style.display="block")
    }
})

// ELUA
EULA_closeButon.addEventListener("click", () => {
    if (EULA_accept_ckbx.checked) {
        closeModal(EULAContainer)
        window.userSettings.EULA_accepted = true
        saveUserSettings()
    }
})
if (!Object.keys(window.userSettings).includes("EULA_accepted") || window.userSettings.EULA_accepted==false) {
    EULAContainer.style.opacity = 0
    EULAContainer.style.display = "flex"
    chrome.style.opacity = 1
    requestAnimationFrame(() => requestAnimationFrame(() => EULAContainer.style.opacity = 1))
}
// Links
document.querySelectorAll('a[href^="http"]').forEach(a => a.addEventListener("click", e => {
    event.preventDefault();
    shell.openExternal(a.href);
}))