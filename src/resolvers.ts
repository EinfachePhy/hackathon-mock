import {authenticated, authorized} from "./auth";
import {AuthenticationError, PubSub} from 'apollo-server'
import {GraphQLUpload} from 'graphql-upload'
import {ImageToken} from "./constants";
import FormData from 'form-data';
import {storeUpload} from "./utils";
import {existsSync, unlinkSync} from 'fs'

const request  = require('request')


const pubsub = new PubSub()
const NEW_POST = 'NEW_POST'
export default {
    Upload: GraphQLUpload,
    Query: {
        category: async (_, __, { ___, models }) => {
            return models.Category.findAll()
        },
        email: async (_, input , {___, models}) => {
            const user =  models.User.findOne(input)
            return { ...input, available: !!user}
        },

        me: authenticated((_, __, {user}) => {
            return user
        }),
        posts: async (_, __, {___, models}) => {
            return models.Post.findMany()
        },

        post: authenticated((_, {id}, {user, models}) => {
            return models.Post.findOne({id, author: user.id})
        }),

        userSettings: authenticated((_, __, {user, models}) => {
            return models.Settings.findOne({user: user.id})
        }),
        feed (_, __, {models}) {
            return models.Post.findMany()
        }
    },
    Mutation: {
        likeAction:  authenticated((_, {target: id},{user, models})=> {
            const post = models.Post.findOne({ id })

            const index = post.likes.indexOf(user.id)
            if (index !== -1){
                post.likes.splice(index, 1)
            } else {
                post.likes.push(user.id)
            }
            return models.Post.updateOne({ id }, post)
            }),

        updateSettings: authenticated((_, {input}, {user, models}) =>{
            return models.Settings.updateOne({user: user.id}, input)
        }),

        createPost: authenticated(async (_, {input}, {user: { id }, models}) => {
            const { category } = input
            const fullCategory = models.Category.findOne({ value: category })
            const post = models.Post.createOne({...input, author: id, ...fullCategory, likes: [], views: 0, comments: []})
            await pubsub.publish(NEW_POST, { newPost: post })
            return post
        }),
        updateMe: authenticated((_, {input}, {user, models}) => {
            return models.User.updateOne({id: user.id}, input)
        }),
        // admin role
        invite: authenticated(authorized('ADMIN', (_, {input}, {user}) => {
            return {from: user.id, role: input.role, createdAt: Date.now(), email: input.email}
        })),
        signUp(_, {input}, {models, createToken}) {
            const existing = models.User.findOne({email: input.email}) || models.User.findOne({ name: input.name})
            if (existing) {
                throw new AuthenticationError('Username or Email duplicated!')
            }

            const user = models.User.createOne({...input, verified: false , role: 'MEMBER', avatar: input.name})
            const token = createToken(user)
            models.Setting.createOne({user: user.id, theme: 'DARK', emailNotifications: true, pushNotifications: true})
            return {token, user}
        },
        signIn(_, {input}, {models, createToken}) {
            const user = models.User.findOne(input)
            if (!user) {
                throw new AuthenticationError('wrong email + password combo')
            }

            const token = createToken(user)

            return {token, user}
        },
        sendImageToCloud: authenticated(async (_, {file})  => {
             let result
             const { createReadStream, filename, mimetype } = await file
             // save to local first
             const [{ path },  err] = await storeUpload({ stream: createReadStream(), mimetype, filename})
                 .then(res => [res, null])
                 .catch(err => [null, err])
             const form = new FormData()
             form.append('smfile', createReadStream())
             form.append('format', 'json')
             if (!err) {
                 return await new Promise(((resolve, reject) => {
                     const req = request.post({
                         url: 'https://sm.ms/api/v2/upload',
                         headers: {Authorization: ImageToken, ...form.getHeaders()}
                     }, (err, response, body) => {
                         if (existsSync(path)) {
                             unlinkSync(path)
                         }
                         if (err) {
                             result = {message: err, res: ''}
                             reject(result)
                         } else {
                             result = {message: 'success', res: body}
                             resolve(result)
                         }
                     })
                     form.pipe(req)
                 }))
             }
             return { message: 'Failed to save!', res: ''}
         }),
        addComment: authenticated( (_,  { pid, content }, {user: {id, name}, models})  => {
            const { comments } = models.Post.findOne({ id })
            return models.Post.updateOne({id}, {comments: [...comments, content]})
        })
    },
    Subscription: {
        newPost: {
            subscribe: () => pubsub.asyncIterator(NEW_POST)
        },
    },
    User: {
        posts(root, _, {user, models}) {
            if (root.id !== user.id) {
                throw new AuthenticationError('not your posts')
            }

            return models.Post.findMany({author: root.id})
        },
        settings(root, __, {user, models}) {
            return models.Settings.findOne({id: root.settings, user: user.id})
        }
    },
    Settings: {
        user(settings, _, {user, models}) {
            return models.Settings.findOne({id: settings.id, user: user.id})
        }
    },
    Post: {
        author(post, _, {models}) {
            return models.User.findOne({id: post.author})
        },
        likes(post, _, {models}) {
            const users = post.likes.map(id => models.User.findOne({id}))
            return post.likes.map(id => models.User.findOne({id}))
        }
    }
}
