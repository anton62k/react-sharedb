import { useMemo, useLayoutEffect, useRef, useCallback, useState } from 'react'
import Doc from './types/Doc'
import Query from './types/Query'
import QueryExtra from './types/QueryExtra'
import Local from './types/Local'
import Value from './types/Value'
import Api from './types/Api'
import batching from './batching'
import {
  subDoc,
  subLocal,
  subValue,
  subQuery,
  subApi
} from './subscriptionTypeFns'
import $root from '@react-sharedb/model'

const HOOKS_COLLECTION = '$hooks'
const $hooks = $root.scope(HOOKS_COLLECTION)

export const useDoc = generateUseItemOfType(subDoc)
export const useQuery = generateUseItemOfType(subQuery)
export const useLocal = generateUseItemOfType(subLocal)
export const useValue = generateUseItemOfType(subValue)
export const useApi = generateUseItemOfType(subApi)

function generateUseItemOfType (typeFn) {
  let isQuery = typeFn === subQuery
  let hasDataFn = typeFn === subDoc || typeFn === subQuery
  let isSync = typeFn === subLocal || typeFn === subValue
  let useDymamic = isSync ? useSync : useAsync
  return (...args) => {
    let hookId = useMemo(() => $root.id(), [])
    let hashedArgs = useMemo(() => JSON.stringify(args), args)
    let forceUpdate = useForceUpdate()

    const initsCountRef = useRef(0)
    const cancelInitRef = useRef()
    const itemRef = useRef()
    const destructorsRef = useRef([])

    useUnmount(() => {
      if (cancelInitRef.current) cancelInitRef.current.value = true
      itemRef.current = undefined
      destructorsRef.current.forEach(destroy => destroy())
      destructorsRef.current.length = 0
      $hooks.destroy(hookId)
    })

    const params = useMemo(() => typeFn(...args), [hashedArgs])

    const finishInit = useCallback(() => {
      // destroy the previous item and all unsuccessful item inits which happened until now.
      // Unsuccessful inits means the inits of those items which were cancelled, because
      // while the subscription was in process, another new item init started
      // (this might happen when the query parameter, like text search, changes quickly)
      // Don't destroy self though.
      destructorsRef.current.forEach((destroy, index) => {
        if (index !== destructorsRef.current.length - 1) destroy()
      })

      // Clear all destructors array other then current item's destroy
      destructorsRef.current.splice(0, destructorsRef.current.length - 1)

      // Mark that initialization completed
      initsCountRef.current++

      // Reference the new item data
      itemRef.current && itemRef.current.refModel()

      // Force rerender if the data is received manually
      if (hasDataFn) forceUpdate()
    }, [])

    const initItem = useCallback(params => {
      let item = getItemFromParams(params, hookId)
      destructorsRef.current.push(() => {
        item.unrefModel()
        item.destroy()
      })

      if (isSync) {
        // since initialization happens synchronously,
        // there is no need to bother with cancellation of
        // the previous item
        itemRef.current = item
        batching.batch(finishInit)
      } else {
        // Cancel initialization of the previous item
        if (cancelInitRef.current) cancelInitRef.current.value = true
        // and init new
        let cancelInit = {}
        cancelInitRef.current = cancelInit

        // If there is no previous item, it means we are the first
        let firstItem = !itemRef.current
        // Cancel previous item
        if (itemRef.current) itemRef.current.cancel()
        // and init new
        itemRef.current = item

        item
          .init(firstItem)
          .then(() => {
            // Handle situation when a new item already started initializing
            // and it cancelled this (old) item
            if (cancelInit.value) return
            batching.batch(finishInit)
          })
          .catch(err => {
            console.warn(
              "[react-sharedb] Warning. Item couldn't initialize. " +
                'This might be normal if several resubscriptions happened ' +
                'quickly one after another. Error:',
              err
            )
            // Ignore the .init() error
            return Promise.resolve()
          })
      }
    }, [])

    useDymamic(() => initItem(params), [hashedArgs])

    // ----- model -----

    // For Query and QueryExtra return the scoped model targeting the actual collection path.
    // This is much more useful since you can use that use this returned model
    // to update items with: $queryCollection.at(itemId).set('title', 'FooBar')
    const collectionName = useMemo(
      () => (isQuery ? getCollectionName(params) : undefined),
      [hashedArgs]
    )
    const $queryCollection = useMemo(
      () => (isQuery ? $root.scope(collectionName) : undefined),
      [collectionName]
    )

    // For Doc, Local, Value return the model scoped to the hook path
    // But only after the initialization actually finished, otherwise
    // the ORM won't be able to properly resolve the path which was not referenced yet
    const $model = useMemo(
      () => (!isQuery && initsCountRef.current ? $hooks.at(hookId) : undefined),
      [initsCountRef.current]
    )

    // ----- data -----

    // In any situation force access data through the object key to let observer know that the data was accessed
    let data = initsCountRef.current
      ? hasDataFn
        ? itemRef.current && itemRef.current.getData()
        : $hooks.get()[hookId]
      : undefined

    console.log('>> hook data', data)
    console.log('>> hook data length', Array.isArray(data) && data.length)

    // ----- return -----

    return [
      data,

      // Query, QueryExtra: return scoped model to collection path.
      // Everything else: return the 'hooks.<randomHookId>' scoped model.
      $queryCollection || $model,

      // explicit ready flag
      !!initsCountRef.current
    ]
  }
}

function getCollectionName (params) {
  return params && params.params && params.params[0]
}

function getItemFromParams (params, key) {
  let explicitType = params && params.__subscriptionType
  let subscriptionParams = params.params
  let constructor = getItemConstructor(explicitType)
  return new constructor($root.connection, key, subscriptionParams)
}

function getItemConstructor (type) {
  switch (type) {
    case 'Local':
      return Local
    case 'Doc':
      return Doc
    case 'Query':
      return Query
    case 'QueryExtra':
      return QueryExtra
    case 'Value':
      return Value
    case 'Api':
      return Api
    default:
      throw new Error('Unsupported subscription type: ' + type)
  }
}

function useUnmount (fn) {
  useLayoutEffect(() => fn, [])
}

function useSync (fn, inputs) {
  useMemo(() => {
    fn()
  }, inputs)
}

function useAsync (fn, inputs) {
  useLayoutEffect(() => {
    fn()
  }, inputs)
}

function useForceUpdate () {
  const [tick, setTick] = useState(1)
  return () => {
    setTick(tick + 1)
  }
}
