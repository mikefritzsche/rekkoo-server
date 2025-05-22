const express = require('express');

/**
 * Creates and returns a router with stock images routes
 * @param {Object} stockImagesController - Controller with stock images API methods
 * @returns {express.Router} Express router
 */
function createStockImagesRouter(stockImagesController) {
  const router = express.Router();

  /**
   * @route GET /
   * @desc Search for stock images from Pexels API
   * @access Public
   */
  router.get('/', stockImagesController.searchImages);

  /**
   * @route GET /:id
   * @desc Get a specific image by ID from Pexels API
   * @access Public
   */
  router.get('/:id', stockImagesController.getImageById);

  return router;
}

module.exports = createStockImagesRouter;

function debounce(func, wait) {
  let timeout;

  return function (...args) {
    const context = this;

    clearTimeout(timeout);

    timeout = setTimeout(() => {
      func.apply(context, args);
    }, wait);
  };
}

function handleInput(event) {
  console.log('Input value:', event.target.value);

  searchImages({query: event.target.value})
}

const debouncedHandleInput = debounce(handleInput, 500);

async function getUnsplashImages(query = '') {
  const url = 'https://api.unsplash.com/search/photos'
  const queryParams = {
    client_id: 'icVtgxFam0JGAsAm7JBdvWGlTzCMKRsecd1D8hodzMg',
    query,
    orientation: 'landscape'
  }
  try {
    const resp = await fetch(`${url}?${new URLSearchParams(queryParams)}`)
    return await resp.json()
  } catch (e) {
    return {error: e}
  }
}

async function getPexelsImages({query, pagingQuery}) {
  let baseUrl = 'https://api.pexels.com/v1/search'
  let url

  const queryParams = {
    query,
    orientation: 'landscape',
    per_page: 18
  }
  console.log(`searchParams: `, new URLSearchParams(queryParams))

  if (pagingQuery) {
    url = pagingQuery
  } else {
    url = `${baseUrl}?${new URLSearchParams(queryParams)}`
  }
  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: 'DDqhmYvwX1pBgj94rdHSgsJn1j44rYt5on69A4VnRDDu0hXLO47CH5Cy'
      }
    })
    return resp.json()
  } catch (e) {
    console.log(`error: `, e)
    return {status: 500, error: e}
  }
}

async function searchImages({query, pagingQuery}) {
  const list = document.querySelector('.wallpaper-list')
  const paging = document.querySelector('.paging-controls')
  const loadingSpinner = document.querySelector('.loading-spinner')
  paging.classList.remove('active')
  loadingSpinner.innerHTML = 'Loading...'

  const fetchedImages = await getPexelsImages({query, pagingQuery})
  console.log(`fetchedImages: `, fetchedImages)
  loadingSpinner.innerHTML = ''

  if (!pagingQuery) {
    list.innerHTML = ''
  }

  fetchedImages.photos.forEach(image => {
    const li = document.createElement('li')
    const img = document.createElement('img')
    img.src = image.src.small
    img.setAttribute('id', image.id)
    img.alt = image.alt || 'image'; // Add alt text for accessibility
    li.appendChild(img)
    list.appendChild(li)
  })
  if (fetchedImages.next_page) {
    paging.querySelector('.next-page').setAttribute('data-next-page', fetchedImages.next_page)
    paging.classList.add('active')
  }
}

async function fetchImage(e) {
  console.log(`e.target.tagName: `, e.target.tagName)
  const li = e.target.closest('li');
  if (li) {
    // Handle the click event on the <li> element
    console.log('Clicked on:', li.textContent);
    console.log(`fetchImage: `, e.target.id)
    try {
      const resp = await fetch(`https://api.pexels.com/v1/photos/${e.target.id}`, {
        headers: {
          Authorization: 'DDqhmYvwX1pBgj94rdHSgsJn1j44rYt5on69A4VnRDDu0hXLO47CH5Cy'
        }
      })
      const image = await resp.json()
      console.log(`image: `, image)
    } catch (e) {
      console.log(`error: `, e)
    }
  }
}

