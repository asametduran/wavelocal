import jsmediatags from 'jsmediatags/dist/jsmediatags.min.js'

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba)$/i
let uid = 0

export const isAudioFile = (f) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name)

const stripExt = (n) => n.replace(/\.[^.]+$/, '')

function readTags(file) {
  return new Promise((resolve) => {
    try {
      jsmediatags.read(file, { onSuccess: (r) => resolve(r.tags || {}), onError: () => resolve({}) })
    } catch {
      resolve({})
    }
  })
}

function pictureToUrl(picture) {
  if (!picture?.data?.length) return null
  const blob = new Blob([new Uint8Array(picture.data)], { type: picture.format || 'image/jpeg' })
  return URL.createObjectURL(blob)
}

/** Turn a File into a track object (all in-memory, nothing leaves the browser). */
export async function fileToTrack(file) {
  const tags = await readTags(file)
  const base = stripExt(file.name)
  return {
    id: `t${++uid}-${Date.now().toString(36)}`,
    file,
    url: URL.createObjectURL(file),
    title: (tags.title || '').trim() || base,
    artist: (tags.artist || '').trim() || 'Unknown Artist',
    album: (tags.album || '').trim() || '',
    cover: pictureToUrl(tags.picture),
    duration: 0,
  }
}

export async function filesToTracks(fileList) {
  const files = Array.from(fileList).filter(isAudioFile)
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return Promise.all(files.map(fileToTrack))
}

export function revokeTrack(t) {
  URL.revokeObjectURL(t.url)
  if (t.cover) URL.revokeObjectURL(t.cover)
}
