/**
 * Two tiny files of real, decodable audio, for the tests that only a real browser can answer: does decodeAudioData accept this,
 * and does the waveform come out right? (The builders in src/test-utils make containers that parse but hold no real audio, and
 * the WAV and FLAC ones are decoded by our own code.) Both are synthetic: a 1 kHz tone, 1.5 s loud (amplitude 0.0625), 1 s of
 * silence, 1.5 s quiet (0.03125), mono at 16 kHz, made once with ffmpeg 9.0 and kept here as base64 so that no binary is committed:
 *
 *   GRAPH='sine=frequency=1000:duration=1.5:sample_rate=16000,volume=0.5[a];anullsrc=r=16000:cl=mono,atrim=0:1[b];
 *          sine=frequency=1000:duration=1.5:sample_rate=16000,volume=0.25[c];[a][b][c]concat=n=3:v=0:a=1[out]'
 *   ffmpeg -filter_complex "$GRAPH" -map '[out]' -ar 16000 -ac 1 -c:a libmp3lame -b:a 16k -id3v2_version 3 -write_xing 0 tone.mp3
 *   ffmpeg -filter_complex "$GRAPH" -map '[out]' -ar 16000 -ac 1 -c:a libvorbis -q:a -1 tone.ogg
 *
 * Chromium decodes both. (The Chromium that Playwright ships has no AAC decoder, so there is no M4A here.)
 */

/** MP3, 16 kbit/s, 4.1 s, with a small ID3v2 tag in front: 8252 bytes. */
const MP3_BASE64 =
  'SUQzAwAAAAAAIlRTU0UAAAAOAAAATGF2ZjYzLjEuMTAyAAAAAAAAAAAAAAD/8yjEAArwAso/QRgCkkk+KbbYAAHwfB8HwcBAEAQDETg/xAcLggGDnB/wQlPP' +
  '8o7QH+BHc/ynv6EVhFeC0Kvg2gK+Q4XMGXv/8yjEDxBxMoABiqAA8TaFoIBjsD/A8IsQZ4wixBngA4KGrRyhmhlv/JkipFTIvF7/9Eul1IGm/lQkDQlCX/Bp' +
  '////MHEx2KL/8yjECA64viQBwvAAwwVAAQHmAgAyYGQQJh3CsmKtS+ckBY5lQDUmFIBOYBABxgfgaCQCzKy1r8yp3n/////Q//+r//4R43z/8yjECAbi1fAA' +
  'uA9oGWsn//q/+od/////9///X//5UZr//6v//hHjfBlrJ//6v/qHf/////f//1//+VGa//+r//4R43wZayf/8yjEJwbi1fAAuA9o//q/+od/////9///X//5' +
  'UZr//6v//hHjfBlrJ//6v/qHf/////f//1//+VGa//+r//4R43wZayf/+r//8yjERgbi1fAAuA9o+od/////9///X//5UZr//6v//hHjfBlrJ//6v/qHf///' +
  '//f//1//+VGa//+r//4R43wZayf/+r/6h3//8yjEZQbi1fAAuA9o////9///X//5UZpM//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqq' +
  'qqqqqqqqqqr/8yjEhAbi1fAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjEowbi1fAA' +
  'uA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjEwgbi1fAAuA9oqqqqqqqqqqqqqqqq//+r' +
  '//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3' +
  '//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqq' +
  'qqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAA' +
  'uA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r' +
  '//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3' +
  '//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqq' +
  'qqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAA' +
  'uA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r' +
  '//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3' +
  '//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqq' +
  'qqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAA' +
  'uA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r' +
  '//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3' +
  '//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqq' +
  'qqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAA' +
  'uA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r' +
  '//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3' +
  '//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqq' +
  'qqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAA' +
  'uA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r' +
  '//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3' +
  '//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1fAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmv///0AEEh9y4bLh' +
  'EAFGAaAHxgD/8yjE4Abi1fAAuA9oYAFmAbgbphD4YCYO+m3mbgBf5gVASwYPMCAGBTARhgEACOYCqAWmAOgC4hAAEaGYN7D9v////6P/////8yjE4Abi1fAA' +
  'uA9o/5MAoIMYk4QDzQ0RJPnDcbSV5ufD0BFyYIoeJkc0QlwifBlYmxlwTPgbYOMcGRg1cGBvhx5PmBcYG8T/8yjE4Abi1fAAuA9oKCJkgpFf7+OULmFzEyQU' +
  'gP9t9jIvF4xLpdS+XnAGDQlCQNN+XAgYB8CBgHQkDRU7/7k1pZEia2KFDKL/8yjE4Abi1fAAuA9ohQs4sRCpmkQqJmlQqCLSopFKHFhUKkgSA0JpocWFTKyJ' +
  'rYoK2CuCjoR3gqpMQU1FMy4xMDCqqqqqqqr/8yjE/xQAxhABR/gAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqq' +
  'qqqqqqqqqqr/8yjE6hrZdojVi6AAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjEuQzIyhgB' +
  'yUgBqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjEwAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqq' +
  'qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' +
  'qqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqq' +
  'qqqqqqqqqqr/8yjExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjExAAAA0gA' +
  'AAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqq' +
  'qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' +
  'qqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqq' +
  'qqqqqqqqqqr/8yjExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjExAAAA0gA' +
  'AAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqq' +
  'qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' +
  'qqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqq' +
  'qqqqqqqqqqr/8yjExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjExAAAA0gA' +
  'AAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqq' +
  'qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' +
  'qqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqq' +
  'qqqqqqqqqqr/8yjExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjExAAAA0gA' +
  'AAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjExAAAA0gAAAAAqqqqqqqqqqqqqqqqqqqq' +
  'qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTQU5bgPiF1/3c4iFxEJwMWb/8yjExAAAA0gAAAAA9k06IAAILAAw8BhazCCEEDgn5R3T/n/orP/y58u+CEhL' +
  'n1//wxL11ZIhOiY51eGSgnNsTxBzD73WUTv/8yjExAAAA0gAAAAAL13JooTN8rNbYUXoEghAKCRgxtNDXjVoqK5TAsTjEovWzAQJG9xlhW6c3jztPlYsY5y1' +
  '2oLtRmSa////8yjExAAAA0gAAAAA/PWGG+58jVD2loMP////1zD+5/zlNV3ZratVd/TcmAQoDJIKAVv/8BEQmZIjTKr///6CMFwKieRAADD/8yjExAAAA0gA' +
  'AAAAAEAEAwA8AkAwB0AHAwEYBXAwJAE7AwiwMRAww5a/A1AoYxAxdwO/AwYoB5AwDIBCAwK0CWAwDsAABt//8yjE/A3ItdwfQzAAAwB4ATC6kQmC5o3R////' +
  '/////9Z7/////5P//6v//hHjfBlrJ//6v/qHf/////f//1//+VGa//+r//7/8yjE/x8JvmQBj9gAEeN8GWsn//q/+od/////9///X//5UZr//6v//hHjfBlr' +
  'J//6v/qHf/////f//1//+VGaTEFNRTMuMTD/8yjEvRhBtfwBx7gAMKqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqq' +
  'qqqqqqqqqqr/8yjElwbi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjEtgbi1eAA' +
  'uA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE1Qbi1eAAuA9oqqqqqqqqqqqqqqqq//+r' +
  '//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3' +
  '//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqq' +
  'qqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAA' +
  'uA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r' +
  '//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3' +
  '//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqq' +
  'qqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAA' +
  'uA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r' +
  '//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3' +
  '//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqq' +
  'qqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAA' +
  'uA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r' +
  '//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3' +
  '//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqq' +
  'qqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAA' +
  'uA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r' +
  '//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3' +
  '//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqq' +
  'qqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAA' +
  'uA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r' +
  '//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3' +
  '//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqq' +
  'qqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAA' +
  'uA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r' +
  '//4R43wZayf/+r/6h3/////3//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3' +
  '//9f//lRmkxBTUUzLjEwMKqqqqqqqqqqqqr/8yjE4Abi1eAAuA9oqqqqqqqqqqqqqqqq//+r//4R43wZayf/+r/6h3/////3//9f//lRmsXIxWj1RjFEAoFD' +
  'Fo26IwuCYbb/8yjE4Abi1eAAuA9oygoMEbWF2KkcSIg0ATAkFTDEQTBeATVgVQCCgCCACAAnxefd378Nv+/8bt1JRSblEYllJzOnt6p6enz/8yjE4Abi1eAA' +
  'uA9o/www3SUljD8889V6cfgIiADg9oPPwERADw/w9+BmAj4/h7+OwM//D//8Hf/j6kAFpCuU+FTC1IrwkoT/8yjE4Abi1eAAuA9o0ZLEFQ2YG86nMeFkQBGQ' +
  'D6hl1ZqZJeBgGF8BcIfELW6knb5PDKj4NSLEqtqv9yKlhi8WU//8umSjYxX/8yjE4Abi1eAAuA9ompkr/gyJQoBSQU//ApIKGiQ41UxBTUUzLjEwMFVVVVVV' +
  'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8yjE/x7RTkQBSegBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
  'VVVVVVVVVVX/8yjEvhapmmQJjZgAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8yjEngAAA0gB' +
  'wAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU='

/** Ogg Vorbis, mono, 4.0 s: 6627 bytes. */
const OGG_BASE64 =
  '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' +
  'WowptRZDKamFUlorpbSWWqoxtVZjxJiUzDkpmWNSSimtlVJaqxyTkjEoqYOQSikpxVJSi5VzUjLoqHQQSiqpxFRSaa2k0lIppcWSUmwpxVRbi7WGUlosqcRW' +
  'UmoxtVRbizHXiDEpGXNSMueklFJSK6W0ljknpYOOSuagpJJSa6WkFDPmpHQOSsogo1JSii2lElMopbWSUmylpNZajLWm1FotJbVWUmqxlBJbizHXFktNnZTW' +
  'SioxhlJaazHmmlqLMZQSWykpxpJKbK3FmltsOYZSWiypxFZKarHVlmNrsebUUo0ptZpbbLnGlFOPtfacWqs1tVRja7HmWFtvtdacOymthVJaKyXFmFqLscVY' +
  'cygltpJSbKWkGFtsubYWYw+htFhKarGkEmNrMeYYW46ptVpbbLmm1GKttfYcW249pRZri7Hm0lKNNdfeY005FQAAMOAAABBgQhkoNGQlABAFAAAYwxhjEBql' +
  'nHNOSoOUc85JyZyDEEJKmXMQQkgpc05CSi1lzkFIqbVQSkqtxRZKSam1FgsAAChwAAAIsEFTYnGAQkNWAgBRAACIMUoxBqExRinnIDTGKMUYhEopxpyTUCnF' +
  'mHNQMsecg1BK5pxzEEoJIZRSSkohhFJKSakAAIACBwCAABs0JRYHKDRkRQAQBQAAGGOcM84hCp2lzlIkqaPWUWsopRpLjJ3GVnvrudMae225N5RKjanWjmvL' +
  'udXeaU09txwLAAA7cAAAO7AQCg1ZCQDkAQAQxijFmHPOGYUYc8455wxSjDnnnHOKMeecgxBCxZhzzkEIIXPOOQihhJI55xyEEEronINQSimldM5BCKGUUjrn' +
  'IIRSSimdcxBKKaWUAgCAChwAAAJsFNmcYCSo0JCVAEAeAABgDELOSWmtYcw5CC3V2DDGHJSUYoucg5BSi7lGzEFIKcagOygptRhs8J2ElFqLOQeTUos1596D' +
  'SKm1moPOPdVWc8+995xirDXn3nMvAAB3wQEA7MBGkc0JRoIKDVkJAOQBABAIKcWYc84ZpRhzzDnnjFKMMeacc4oxxpxzzkHFGGPOOQchY8w55yCEkDHmnHMQ' +
  'Quiccw5CCCF0zjkHIYQQOueggxBCCJ1zEEIIIYQCAIAKHAAAAmwU2ZxgJKjQkJUAQDgAAAAhhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGE' +
  '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'

export const realMp3 = (): Buffer => Buffer.from(MP3_BASE64, 'base64')
export const realOgg = (): Buffer => Buffer.from(OGG_BASE64, 'base64')
