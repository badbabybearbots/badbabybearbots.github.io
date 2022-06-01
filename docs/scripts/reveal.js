(async () => {
  //sets up the MM SDK
  MetaMaskSDK.setup(blocknet)
  
  //const ipfs = await Ipfs.create()

  //------------------------------------------------------------------//
  // Classes

  class TaskRunner {
    constructor(maxThreads = 1) {
      this.done = 0
      this.queue = []
      this.progress = []
      this.retried = {}
      this.datalist = []
      this.layers = { __count: {} }
      this.totalOccurrances = 0
      this.threads = 0
      this.maxThreads = maxThreads
    }

    async init(network, contract) {
      this.network = network
      this.contract = MetaMaskSDK
        .network(network)
        .addContract('target', contract, blocknet.abi.erc721)
        .contract('target')

      this.supply = parseInt(await (this.contract.read().totalSupply()))
    }

    async task(id) {
      //download the json
      const uri = await (this.contract.read().tokenURI(id))
      const response = await fetch(uri.replace('ipfs://', 'https://ipfs.io/ipfs/'))
      const json = await response.json()

      if (!Array.isArray(json.attributes)) {
        return
      }

      const attributes = {}
      for (const attribute of json.attributes) {
        //add to the data list
        attributes[attribute.trait_type] = { value: attribute.value }
        //add to layer
        this._addLayerAttribute(attribute.trait_type, attribute.value)
        //add to total occurances
        this.totalOccurrances++
      }
      //also add the count to layers
      const attributeCount = Object.keys(attributes).length
      attributes.__count = { value: attributeCount }
      //add to layer
      this._addLayerAttribute('__count', attributeCount)
      //add to total occurances
      this.totalOccurrances++

      this.datalist.push({ tokenId: id, ...{
        name: json.name,
        image: json.image
      }, attributes })
    }

    thread(resolve, progress, error) {
      //if queue is empty
      if (!this.queue.length) {
        //if there is nothing in progress
        if (!this.progress.length) return resolve()
        //we cant do anything
        return
      }
      //get token id
      const tokenId = this.queue.shift()
      //if it's already in progress
      if (this.progress.indexOf(tokenId) !== -1) {
        //move on to the next one
        return this.thread(resolve, progress, error)
      }
      //set this in progress
      this.progress.push(tokenId)
      this.task(tokenId).then(_ => {
        this.done++
        //remove from progress
        if (this.progress.indexOf(tokenId) !== -1) {
          this.progress.splice(this.progress.indexOf(tokenId), 1)
        }
        //if nothing in queue and nothing in progress then we are done
        if (!this.queue.length && !this.progress.length) return resolve()
        //otherwise, move on to the next one
        this.thread(resolve, progress, error)
      }).catch(e => {
        //remove from progress
        if (this.progress.indexOf(tokenId) !== -1) {
          this.progress.splice(this.progress.indexOf(tokenId), 1)
        }
        const retry = this._retry(tokenId)
        //report this error
        error(e, tokenId, retry)
        //okay to retry?
        if (retry) {
          this.queue.push(tokenId)
          //move on to the next one
          this.thread(resolve, progress, error)
        }
      })
      //report progess
      progress(tokenId, this.done, this.queue.length, this.progress.length)
    }

    run(progress, error) {
      //build queue
      this.queue = []
      for (let i = 0; i < this.supply; i++) {
        this.queue.push(i + 1)
      }
      return new Promise(resolve => {
        for (let i = 0; i < this.maxThreads; i++) {
          this.thread(resolve, progress, error)
        }
      })
    }
  
    _addLayerAttribute(attribute, value) {
      //if no layer yet
      if (!this.layers[attribute]) {
        //make a layer
        this.layers[attribute] = {}
      }
  
      //if no layer attribute yet
      if (!this.layers[attribute][value]) {
        //make a layer attribute
        this.layers[attribute][value] = 0
      }
      //add occurance to layer attribute
      this.layers[attribute][value]++
    }

    _retry(tokenId) {
      if (!this.retried[tokenId]) {
        this.retried[tokenId] = 0
      }

      return (++this.retried[tokenId]) < 5
    }
  }

  //------------------------------------------------------------------//
  // Variables

  let active

  const fields = {
    cache: document.getElementById('cache'),
    address: document.getElementById('address'),
    network: document.getElementById('network'),
    opensea: document.getElementById('opensea'),
    throttle: document.getElementById('throttle')
  }

  const template = {
    row: document.getElementById('template-table-row').innerHTML,
    modal: document.getElementById('template-modal').innerHTML,
    attribute: document.getElementById('template-attribute').innerHTML
  }

  const status = document.querySelector('div.progress-status')
  const progress = document.querySelector('div.progress-bar-meter')
  const results = document.querySelector('section.results table tbody')
  const pager = document.querySelector('div.pager')

  //------------------------------------------------------------------//
  // Functions

  const render = async function(dataset, page = 1, limit = 30) {
    const start = (page - 1) * limit
    dataset = dataset.slice(start, start + limit)
    const ids = dataset.map(metadata => `token_ids=${metadata.tokenId}`)
    const address = fields.address.value.trim()
    const network = fields.network.value.trim()
    const opensea = fields.opensea.value.trim()
  
    const response = await fetch(`https://api.opensea.io/api/v1/assets?include_orders=true&limit=${limit}&asset_contract_address=${address}&${ids.join('&')}`, {
      headers: {'X-API-KEY': opensea}
    })
    const listings = await response.json()

    results.innerHTML = ''
    dataset.forEach(metadata => {
      const listing = listings.assets.filter(listing => 
        listing.token_id == metadata.tokenId
        && listing.sell_orders?.length
        && listing.sell_orders[0].base_price
      )
      const price = listing.length 
        ? `<img src="https://openseauserdata.com/files/6f8e2979d428180222796ff4a33ab929.svg" height="15" /> ${
          MetaMaskSDK.toEther(listing[0].sell_orders[0].base_price)
        }` : ''
      
      const row = theme.toElement(template.row, {
        '{IMAGE}': metadata.image.replace('ipfs://', 'https://ipfs.io/ipfs/'),
        '{ID}': metadata.tokenId,
        '{SCORE}': (Math.floor(metadata.score * 100) / 100).toLocaleString('en-US', {minimumFractionDigits: 2}),
        '{RANK}': metadata.rank,
        '{PRICE}': price,
        '{NETWORK}': network,
        '{CONTRACT}': address, 
        '{TOKEN}': metadata.tokenId, 
      })

      results.appendChild(row)
      window.doon(row)
    })
  }

  //------------------------------------------------------------------//
  // Events

  document.getElementById('snipe-form').addEventListener('submit', (e) => {
    e.preventDefault()
    return false
  })

  window.addEventListener('snipe-submit', async (e) => {
    const button = e.for.querySelector('button')
    //ignore double click
    if (theme.isDisabled(button)) {
      return
    }
    if (!fields.address.value.trim().length) {
      notify('error', 'Missing contract address')
      return
    }

    //disable button
    theme.disable(button, true)
    theme.hide('section.results', true)

    const throttle = parseInt(fields.throttle.value) || 10
    const address = fields.address.value.trim()
    const network = fields.network.value
    const cache = fields.cache.value == 1

    if (!cache) {
      localStorage.clear()
    }

    let data = localStorage.getItem(address)

    if (!data?.length || !cache) {
      const runner = new TaskRunner(throttle)
    
      try {
        //setup the contract and get supply
        await runner.init(network, address)
        //run the task runner
        await runner.run((id, done) => {
          //update status
          theme.hide('section.progress', false)
          status.innerHTML = `Downloading Token #${id}`
          progress.style.width = `${(done / runner.supply) * 100}%`
        }, (e, id, retry) => {
          //on error, notify
          if (retry) {
            notify('error', `Error on #${id}: ${e.message} - Retrying...`)
          } else {
            notify('error', `Error on #${id}: ${e.message} - Retried too many times.`)
          }
        })
      } catch(error) {
        //enable button
        theme.disable(button, false)
        return notify('error', error.message)
      }

      localStorage.setItem(address, JSON.stringify({ 
        datalist: runner.datalist, 
        layers: runner.layers, 
        totalOccurrances: runner.totalOccurrances
      }))

      data = runner
    } else {
      data = JSON.parse(data)
    }

    const { datalist, layers, totalOccurrances } = active = data 

    //loop through datalist
    for (const metadata of datalist) {
      const attributes = metadata.attributes
      metadata.occurrances = metadata.score = 0
      //loop through each attribute
      for (const attribute in attributes) {
        const value = attributes[attribute].value
        //add the occurrances
        attributes[attribute].occurrances = layers[attribute][value]
        //add to total occurrances
        metadata.occurrances += layers[attribute][value]
        //calculate the score
        attributes[attribute].score = 1 / (layers[attribute][value] / datalist.length)
        //add to total score
        metadata.score +=  attributes[attribute].score
      }
    }

    //sort highest to lowest score
    datalist.sort((a, b) => b.score - a.score)

    //loop through datalist
    let rank = 0
    let lastScore = 0
    for (const metadata of datalist) {
      metadata.rank = lastScore === metadata.score ? rank: ++rank
      lastScore = metadata.score
    }

    //enable button
    theme.disable(button, false)
    //show results
    theme.hide('section.progress', true)
    theme.hide('section.results', false)

    //set the first page
    active.page = 1
    active.range = 30

    if (active.datalist.length > active.range) {
      theme.hide(pager.querySelector('.next'), false)
    }

    render(datalist, active.page, active.range)
  })

  window.addEventListener('page-back-click', (e) => {
    if (active.page == 1) {
      return
    } else if (active.page == 2) {
      theme.hide(e.for, true)
    } else {
      theme.hide(e.for, false)
    }

    theme.hide(pager.querySelector('.next'), false)
    pager.querySelector('.current').innerHTML = --active.page
    render(active.datalist, active.page, active.range)
  })

  window.addEventListener('page-next-click', (e) => {
    if ((active.page * active.range) > active.datalist.length) {
      return
    } else if ((active.page * (active.range * 2)) > active.datalist.length) {
      theme.hide(e.for, true)
    } else {
      theme.hide(e.for, false)
    }

    theme.hide(pager.querySelector('.back'), false)
    pager.querySelector('.current').innerHTML = ++active.page
    render(active.datalist, active.page, active.range)
  })

  window.addEventListener('modal-open-click', (e) => {
    //get id
    const id = parseInt(e.for.getAttribute('data-id'))
    //get datalist
    const { datalist } = active
    //find id
    const metadata = datalist.filter(metadata => metadata.tokenId === id)[0]
    if (!metadata) {
      return notify('error', `Token ${id} does not exist`)
    }

    const modal = theme.toElement(template.modal, {
      '{IMAGE}': metadata.image.replace('ipfs://', 'https://ipfs.io/ipfs/'),
      '{NAME}': metadata.name,
      '{TOKEN}': id,
      '{SCORE}': (Math.floor(metadata.score * 100) / 100).toLocaleString('en-US', {minimumFractionDigits: 2}),
      '{RANK}': metadata.rank
    })

    const attributes = modal.querySelector('div.attributes')

    for (const name in metadata.attributes) {
      const attribute = theme.toElement(template.attribute, {
        '{NAME}': name === '__count' ? 'Trait Count' : name,
        '{VALUE}': metadata.attributes[name].value,
        '{OCCURRANCE}': metadata.attributes[name].occurrances,
        '{TOTAL}': datalist.length.toLocaleString('en-US'),
        '{PERCENT}': Math.floor(
          (metadata.attributes[name].occurrances / datalist.length) * 10000
        ) / 100
      })
      attributes.appendChild(attribute)
    }

    document.body.appendChild(modal)
    window.doon(modal)
  })

  window.addEventListener('modal-overlay-close-click', (e) => {
    if (e.originalEvent.target.classList.contains('modal')) {
      document.body.removeChild(e.for)
    }
  })

  window.addEventListener('modal-close-click', (e) => {
    const modal = document.querySelector(e.for.getAttribute('data-target'))
    modal.parentNode.removeChild(modal)
  })

  //------------------------------------------------------------------//
  // Initialize

  window.doon('body')
})()