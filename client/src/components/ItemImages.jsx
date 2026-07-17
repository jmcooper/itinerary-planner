import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { TrashIcon } from './icons.jsx'

// Images live in a per-trip store on the server; items hold only image ids.
// Image data is fetched lazily: the thumbnail loads the first image when the
// row is expanded, the rest load only when the carousel opens.
export default function ItemImages({ tripId, imageIds, canEdit, onChangeIds }) {
  const [adding, setAdding] = useState(false)
  const [carouselOpen, setCarouselOpen] = useState(false)
  const [firstImage, setFirstImage] = useState(null)
  const firstId = imageIds[0]

  useEffect(() => {
    if (!firstId) {
      setFirstImage(null)
      return
    }
    let alive = true
    api
      .getImage(tripId, firstId)
      .then((img) => {
        if (alive) setFirstImage(img.dataUri)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [tripId, firstId])

  async function addImage(dataUri) {
    const { id } = await api.uploadImage(tripId, dataUri)
    await onChangeIds([...imageIds, id])
    setAdding(false)
  }

  // A pasted Google Maps photo link imports the photo server-side.
  async function addImageFromLink(url) {
    const { id } = await api.importImageFromUrl(tripId, url)
    await onChangeIds([...imageIds, id])
    setAdding(false)
  }

  async function deleteImage(id) {
    await api.deleteImage(tripId, id)
    await onChangeIds(imageIds.filter((x) => x !== id))
  }

  if (imageIds.length === 0) {
    if (!canEdit) return null
    return (
      <div className="itin-images">
        {adding ? (
          <ImageDropzone onImage={addImage} onLink={addImageFromLink} onCancel={() => setAdding(false)} />
        ) : (
          <button type="button" className="btn btn-ghost btn-small" onClick={() => setAdding(true)}>
            Add Image
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="itin-images">
      <button
        type="button"
        className={`img-thumb${imageIds.length > 1 ? ' stacked' : ''}`}
        onClick={() => setCarouselOpen(true)}
        title={imageIds.length > 1 ? `View ${imageIds.length} images` : 'View image'}
      >
        {firstImage ? (
          <img src={firstImage} alt="Itinerary item" />
        ) : (
          <span className="img-loading">Loading…</span>
        )}
        {imageIds.length > 1 && <span className="img-count">{imageIds.length}</span>}
      </button>
      {carouselOpen && (
        <ImageCarousel
          tripId={tripId}
          imageIds={imageIds}
          canEdit={canEdit}
          onClose={() => setCarouselOpen(false)}
          onAdd={addImage}
          onAddLink={addImageFromLink}
          onDelete={deleteImage}
        />
      )}
    </div>
  )
}

function ImageCarousel({ tripId, imageIds, canEdit, onClose, onAdd, onAddLink, onDelete }) {
  const [index, setIndex] = useState(0)
  const [cache, setCache] = useState({})
  // The last slide is the uploader, shown only to editors.
  const slideCount = imageIds.length + (canEdit ? 1 : 0)

  useEffect(() => {
    let alive = true
    for (const id of imageIds) {
      api
        .getImage(tripId, id)
        .then((img) => {
          if (alive) setCache((c) => (c[id] ? c : { ...c, [id]: img.dataUri }))
        })
        .catch(() => {})
    }
    return () => {
      alive = false
    }
  }, [tripId, imageIds])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, slideCount - 1))
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0))
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [slideCount, onClose])

  const current = Math.min(index, slideCount - 1)
  const isUploadSlide = current === imageIds.length
  const currentId = imageIds[current]

  async function handleDelete() {
    if (!window.confirm('Delete this image?')) return
    await onDelete(currentId)
    setIndex((i) => Math.max(0, Math.min(i, imageIds.length - 2)))
  }

  async function handleAdd(dataUri) {
    await onAdd(dataUri)
    setIndex(imageIds.length) // the new image lands where the uploader was
  }

  async function handleAddLink(url) {
    await onAddLink(url)
    setIndex(imageIds.length)
  }

  return (
    <div
      className="carousel-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Itinerary item images"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <button type="button" className="carousel-close" onClick={onClose} aria-label="Close image viewer">
        ✕
      </button>
      <div className="carousel-body">
        <button
          type="button"
          className="carousel-nav"
          onClick={() => setIndex(Math.max(current - 1, 0))}
          disabled={current === 0}
          aria-label="Previous image"
        >
          ‹
        </button>
        <div className="carousel-slide">
          {isUploadSlide ? (
            <ImageDropzone onImage={handleAdd} onLink={handleAddLink} large />
          ) : cache[currentId] ? (
            <figure className="carousel-figure">
              <img src={cache[currentId]} alt={`Itinerary image ${current + 1}`} />
              {canEdit && (
                <button
                  type="button"
                  className="btn-icon btn-icon-danger carousel-delete"
                  onClick={handleDelete}
                  title="Delete this image"
                  aria-label="Delete this image"
                >
                  <TrashIcon />
                </button>
              )}
            </figure>
          ) : (
            <p className="carousel-loading">Loading…</p>
          )}
        </div>
        <button
          type="button"
          className="carousel-nav"
          onClick={() => setIndex(Math.min(current + 1, slideCount - 1))}
          disabled={current === slideCount - 1}
          aria-label="Next image"
        >
          ›
        </button>
      </div>
      <p className="carousel-counter">
        {isUploadSlide ? 'Add an image' : `${current + 1} / ${imageIds.length}`}
      </p>
    </div>
  )
}

const MAPS_LINK_RE =
  /^https:\/\/(maps\.app\.goo\.gl|goo\.gl|(www\.|maps\.)?google\.[a-z.]+|lh\d+\.googleusercontent\.com)\//i

function ImageDropzone({ onImage, onLink, onCancel, large }) {
  const inputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function handleLink(url) {
    if (busy) return
    setError('')
    setBusy(true)
    Promise.resolve(onLink(url)).catch((err) => {
      setError(err.message)
      setBusy(false)
    })
  }

  function handleFile(file) {
    if (busy || !file) return
    if (!file.type.startsWith('image/')) {
      setError('That file is not an image.')
      return
    }
    setError('')
    setBusy(true)
    const reader = new FileReader()
    reader.onload = () => {
      Promise.resolve(onImage(reader.result)).catch((err) => {
        setError(err.message)
        setBusy(false)
      })
    }
    reader.onerror = () => {
      setError('Could not read that file.')
      setBusy(false)
    }
    reader.readAsDataURL(file)
  }

  // Paste works anywhere on the page while a dropzone is visible — image
  // data, or a Google Maps photo link to import server-side.
  useEffect(() => {
    function onPaste(e) {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
        i.type.startsWith('image/')
      )
      if (item) {
        e.preventDefault()
        handleFile(item.getAsFile())
        return
      }
      const text = e.clipboardData?.getData('text')?.trim() ?? ''
      if (onLink && MAPS_LINK_RE.test(text)) {
        e.preventDefault()
        handleLink(text)
      }
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  })

  return (
    <div
      className={`dropzone${dragOver ? ' drag-over' : ''}${large ? ' dropzone-large' : ''}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        handleFile(e.dataTransfer.files?.[0])
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click()
      }}
      aria-label="Upload an image"
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          handleFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      <p className="dropzone-text">
        {busy
          ? 'Uploading…'
          : 'Click to browse, drag & drop, or paste an image or Google Maps photo link'}
      </p>
      {error && <p className="error">{error}</p>}
      {onCancel && !busy && (
        <button
          type="button"
          className="btn btn-ghost btn-small"
          onClick={(e) => {
            e.stopPropagation()
            onCancel()
          }}
        >
          Cancel
        </button>
      )}
    </div>
  )
}
