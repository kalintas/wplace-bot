const BASE_URL = "https://backend.wplace.live";
const SESSION = 0;

const CAPTCHA_CONTEXT_IDENT = "GLOBAL_CAPTCHA_CONTEXT_IDENT";
const CAPTCHA_CALLBACK_IDENT = "GLOBAL_CAPTCHA_CALLBACK_IDENT";
const CURRENT_TILE_IDENT = "CURRENT_TILE_IDENT";
const CURRENT_PIXEL_IDENT = "CURRENT_PIXEL_IDENT";
const START_POINT_IDENT = "START_POINT_IDENT";
const CURRENT_DRAWING_CONFIG_IDENT = "CURRENT_DRAWING_CONFIG_IDENT";
window[CURRENT_DRAWING_CONFIG_IDENT] = JSON.parse(localStorage.getItem(CURRENT_DRAWING_CONFIG_IDENT));

const wplaceBotState = {
    running: false,
    paintedCount: 0,
    charges: { count: 0, max: 80, cooldownMs: 30000 },
    userInfo: null,
    lastPixel: null,
};

const getCurrentDrawingConfig = () => {
    const config = window[CURRENT_DRAWING_CONFIG_IDENT];
    return config ? config : {};
};

const setCurrentDrawingConfig = (config) => {
    window[CURRENT_DRAWING_CONFIG_IDENT] = config;
    localStorage.setItem(CURRENT_DRAWING_CONFIG_IDENT, JSON.stringify(config));
};

const fetchApi = async (path, params = {}) =>
    fetch(BASE_URL + path, { credentials: "include", ...params });

const getCaptchaContext = () => window[CAPTCHA_CONTEXT_IDENT];

const setWplaceBotHook = (context, callback) => {
    window[CAPTCHA_CONTEXT_IDENT] = context;
    window[CAPTCHA_CALLBACK_IDENT] = callback;
    console.log("Set captcha context.");
    document.getElementById("captchaWarningText").style.display = "none";
};

const setWplaceBotCurrentTileAndPixel = (tile, pixel) => {
    window[CURRENT_TILE_IDENT] = tile;
    window[CURRENT_PIXEL_IDENT] = pixel;
    console.log("Set current tile and pixel:", tile, pixel);

    const startingPointInput = document.getElementById("startingPointInput");
    if (!wplaceBotState.running) {
        startingPointInput.value = `Chunk: { x: ${tile[0]}, y: ${tile[1]} }, Pixel: { x: ${pixel[0]}, y: ${pixel[1]} }`;
        const config = getCurrentDrawingConfig();
        config.startPoint = getCurrentTileAndPixel();
        setCurrentDrawingConfig(config);
    }
};

const getCurrentTileAndPixel = () => {
    if (!window[CURRENT_PIXEL_IDENT] || !window[CURRENT_TILE_IDENT]) {
        return null;
    }

    return {
        tile: { x: window[CURRENT_TILE_IDENT][0], y: window[CURRENT_TILE_IDENT][1] },
        pixel: { x: window[CURRENT_PIXEL_IDENT][0], y: window[CURRENT_PIXEL_IDENT][1] },
    };
};

const fetchUserInfo = async () => {
    let response = await fetchApi("/me");
    if (response && response.ok) {
        response = await response.json();
        wplaceBotState.userInfo = response;
        wplaceBotState.charges = {
            count: Math.floor(response.charges.count),
            max: Math.floor(response.charges.max),
            cooldownMs: response.charges.cooldownMs,
        };
        if (leftCharges) {
            leftCharges.innerText = `Charges: ${wplaceBotState.charges.count}`;
        }

        window.dispatchEvent(new CustomEvent("wplace:userInfoReady", { detail: wplaceBotState }));
        return response;
    }

    console.error("WplaceBot: Failed to fetch user info.");
    return null;
};

fetchUserInfo().then((response) => console.log("Fetched user info:", response));

const isContextReady = () => Boolean(getCaptchaContext());

const WPLACE_API_CLIENT_IDENT = "WPLACE_API_CLIENT_IDENT";
const getWplaceApiClient = () => window[WPLACE_API_CLIENT_IDENT];
const setWplaceApiClient = (client) => {
    window[WPLACE_API_CLIENT_IDENT] = client;
};

const hookPaint = async (chunk, coords, colors) => {
    if (!isContextReady()) {
        console.warn("Context is not ready yet.");
        return null;
    }

    const payload = {
        colors,
        coords,
        t: getCaptchaContext().token,
    };

    console.log("Sending paint request...");

    const response = await fetchApi(`/s${SESSION}/pixel/${chunk.x}/${chunk.y}`, {
        method: "POST",
        body: JSON.stringify(payload),
    });
    await window[CAPTCHA_CALLBACK_IDENT]();
    window[CAPTCHA_CONTEXT_IDENT] = null;
    document.getElementById("captchaWarningText").style.display = "block";

    return response;
};

window.setWplaceBotHook = setWplaceBotHook;
window.setWplaceBotCurrentTileAndPixel = setWplaceBotCurrentTileAndPixel;

const getChunkPixels = async ({ x, y }) => {
    const response = await fetch(BASE_URL + `/files/s${SESSION}/tiles/${x}/${y}.png`);
    if (!response.ok) {
        console.error("Could not fetch the chunk at:", x, y);
        return null;
    }
    console.log(`Fetched the chunk png at x: ${x} y: ${y}`);

    const blob = await response.blob();
    const imageBitmap = await createImageBitmap(blob);

    const canvas = document.createElement("canvas");
    canvas.width = imageBitmap.width;
    canvas.height = imageBitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(imageBitmap, 0, 0);

    const { data: pixels } = ctx.getImageData(0, 0, canvas.width, canvas.height);

    return {
        pixels,
        width: canvas.width,
        height: canvas.height,
    };
};

const findNearestColorId = (c) => {
    if (c.r === 0 && c.g === 0 && c.b === 0) {
        return c.a === 0 ? "0" : "1";
    }

    for (const [id, color] of Object.entries(ALL_COLORS_BY_ID)) {
        if (c.r === color.r && c.g === color.g && c.b === color.b) {
            return id;
        }
    }
    return null;
};

const sleepForMs = async (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

const autoFetchCharges = async () => {
    await fetchUserInfo();
    console.log("Current charges: ", wplaceBotState.charges.count);

    if (wplaceBotState.charges.count === 0) {
        const interval = setInterval(() => {
            if (!wplaceBotState.running || wplaceBotState.charges.count !== 0) {
                clearInterval(interval);
                return;
            }
            fetchUserInfo().then(() =>
                console.log("Fetched charges: ", wplaceBotState.charges.count)
            );
        }, 30 * 1000);
    }
};

const startWplaceBot = async ({ width, height }, indicesArray) => {
    console.log("Starting Wplace Bot...");

    let config = getCurrentDrawingConfig();
    if (!config || !config.startPoint) {
        console.error("Wplacebot: Select a point on the map to start the bot");
        wplaceBotState.running = false;
        return;
    }
    const startPoint = config.startPoint;
    console.log(startPoint);

    try {
        await autoFetchCharges();
    } catch (exception) {
        console.warn("Wplacebot: Could not fetch charges: ", exception);
    }

    while (wplaceBotState.running) {
        try {
            let reloadPageTimeout = null;
            if (!isContextReady()) {
                reloadPageTimeout = setTimeout(() => {
                    if (!wplaceBotState.running || isContextReady()) return;

                    console.log(
                        "Wplace bot didn't recieve a captcha for 60 seconds, reloading the page."
                    );
                    config = getCurrentDrawingConfig();
                    config.shouldRunAtStart = true;
                    setCurrentDrawingConfig(config);

                    window.location.reload();
                }, 60 * 1000);
            }

            while ((!isContextReady() || wplaceBotState.charges.count === 0) && wplaceBotState.running) {
                await sleepForMs(100);
            }
            if (reloadPageTimeout) clearTimeout(reloadPageTimeout);
            if (!wplaceBotState.running) break;

            const chunks = [null, null, null, null];
            let currentChunkIndex = 0;
            let coords = [[], [], [], []];
            let colors = [[], [], [], []];
            let charges = Math.floor(wplaceBotState.charges.count);

            const CHUNK_SIZE = 1000;

            for (let y = 0; y < height && charges > 0; ++y) {
                for (let x = 0; x < width && charges > 0; ++x) {
                    const imagePixelId = indicesArray[y][x];
                    if (imagePixelId === 0) continue;

                    let chunkX = x + startPoint.pixel.x;
                    let chunkY = y + startPoint.pixel.y;

                    if (chunkX >= CHUNK_SIZE && chunkY >= CHUNK_SIZE) {
                        currentChunkIndex = 3;
                        if (!chunks[currentChunkIndex]) {
                            chunks[currentChunkIndex] = await getChunkPixels({
                                x: startPoint.tile.x + 1,
                                y: startPoint.tile.y + 1,
                            });
                        }
                        chunkX -= CHUNK_SIZE;
                        chunkY -= CHUNK_SIZE;
                    } else if (chunkX >= CHUNK_SIZE) {
                        currentChunkIndex = 1;
                        if (!chunks[currentChunkIndex]) {
                            chunks[currentChunkIndex] = await getChunkPixels({
                                x: startPoint.tile.x + 1,
                                y: startPoint.tile.y,
                            });
                        }
                        chunkX -= CHUNK_SIZE;
                    } else if (chunkY >= CHUNK_SIZE) {
                        currentChunkIndex = 2;
                        if (!chunks[currentChunkIndex]) {
                            chunks[currentChunkIndex] = await getChunkPixels({
                                x: startPoint.tile.x,
                                y: startPoint.tile.y + 1,
                            });
                        }
                        chunkY -= CHUNK_SIZE;
                    } else {
                        currentChunkIndex = 0;
                        if (!chunks[currentChunkIndex]) {
                            chunks[currentChunkIndex] = await getChunkPixels(startPoint.tile);
                        }
                    }

                    const chunk = chunks[currentChunkIndex];
                    if (!chunk) throw new Error();

                    let chunkPixelIndex = (chunkX + chunk.width * chunkY) * 4;
                    if (chunk.width > CHUNK_SIZE) chunkPixelIndex *= 3;

                    const chunkR = chunk.pixels[chunkPixelIndex];
                    const chunkG = chunk.pixels[chunkPixelIndex + 1];
                    const chunkB = chunk.pixels[chunkPixelIndex + 2];
                    const chunkA = chunk.pixels[chunkPixelIndex + 3];

                    const newPixelColor = ALL_COLORS_BY_ID[imagePixelId];
                    if (!newPixelColor) {
                        console.error(
                            "Wplace bot: input image had invalid color, imagePixelId: ",
                            imagePixelId
                        );
                        continue;
                    }

                    const oldPixelId = findNearestColorId({
                        r: chunkR,
                        g: chunkG,
                        b: chunkB,
                        a: chunkA,
                    });
                    if (parseInt(oldPixelId) === imagePixelId) continue;

                    coords[currentChunkIndex].push(chunkX, chunkY);
                    colors[currentChunkIndex].push(imagePixelId);
                    charges -= 1;
                }
            }

            if (coords.every((array) => array.length === 0) && charges > 0) {
                console.log("Wplace Bot finished! Keep the bot open to avoid invasions.");
                await sleepForMs(10000);
                continue;
            }

            console.log("Sending paint request: ", coords, " ", colors);
            const requests = [];
            if (coords[0].length !== 0)
                requests.push(hookPaint(startPoint.tile, coords[0], colors[0]));
            if (coords[1].length !== 0)
                requests.push(
                    hookPaint({ x: startPoint.tile.x + 1, y: startPoint.tile.y }, coords[1], colors[1])
                );
            if (coords[2].length !== 0)
                requests.push(
                    hookPaint({ x: startPoint.tile.x, y: startPoint.tile.y + 1 }, coords[2], colors[2])
                );
            if (coords[3].length !== 0)
                requests.push(
                    hookPaint(
                        { x: startPoint.tile.x + 1, y: startPoint.tile.y + 1 },
                        coords[3],
                        colors[3]
                    )
                );

            const responses = await Promise.all(requests);
            responses.forEach((response) => {
                if (!response.ok) {
                    console.error("WplaceBot: Error paint request rejected: ", response.status);
                } else {
                    response.json().then((result) => {
                        console.log(`Successfuly painted ${result.painted} pixels.`);
                    });
                }
            });

            await autoFetchCharges();
            await sleepForMs(500);
        } catch (exception) {
            console.error(exception);
            await sleepForMs(5000);
            await fetchUserInfo();
        }
    }

    console.log("Wplace Bot stopped.");
};
