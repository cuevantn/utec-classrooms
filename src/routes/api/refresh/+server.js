import { getXataClient } from '$lib/xata';
import { parseDatetime } from '$lib/utils/parse-datetime';
import { UTEC_TOKEN } from '$env/static/private';

let xata = getXataClient();

/**
 * @typedef {Object} RawEvent
 * @property {string} title - The title of the event.
 * @property {string} start - The start date and time of the event.
 * @property {string} end - The end date and time of the event.
 */

/**
 * @typedef {Object} Course
 * @property {string} code - The code of the course.
 * @property {string} name - The name of the course.
 */

/**
 * @typedef {Object} Host
 * @property {string} name - The name of the host.
 */

/**
 * @typedef {Object} Event
 * @property {Date} start - The start date and time of the event.
 * @property {Date} end - The end date and time of the event.
 * @property {string} classroom - The classroom id of the event.
 * @property {string | undefined} name - The name of the event.
 * @property {string | undefined} course - The course id of the event.
 * @property {string | undefined} host - The host id of the event.
 */

/** @type {import('./$types').RequestHandler} */
export async function GET({ url }) {
	try {
		let classroom_name = url.searchParams.get('classroom_name') ?? 'A101';
		let utec_token = url.searchParams.get('utec_token') ?? UTEC_TOKEN;
		let sessionId = url.searchParams.get('sessionId') ?? '1';

		let classroom = await xata.db.classroom.filter({ name: classroom_name }).getFirstOrThrow();

		if (!classroom.code) {
			throw new Error(`Classroom ${classroom_name} xata record has no code.`);
		}

		let todayMinus5 = new Date();
		todayMinus5.setDate(todayMinus5.getDate() - 5);

		let todayMinus3 = new Date();
		todayMinus3.setDate(todayMinus3.getDate() - 3);

		let todayPlus17 = new Date();
		todayPlus17.setDate(todayPlus17.getDate() + 17);

		let todayPlus19 = new Date();
		todayPlus19.setDate(todayPlus19.getDate() + 19);

		let payload = JSON.stringify({
			codAula: classroom.code,
			fechaInicial: todayMinus3.toLocaleDateString('en-GB', { timeZone: 'America/Lima' }),
			fechaFinal: todayPlus17.toLocaleDateString('en-GB', { timeZone: 'America/Lima' })
		});

		let response = await fetch('https://reserva-intranet.utec.edu.pe/events/', {
			method: 'POST',
			body: payload,
			headers: {
				'X-Auth-Token': utec_token,
				Cookie: `sessionId=${sessionId}`,

				Accept: 'application/json, text/plain, */*',
				'Accept-Encoding': 'gzip, deflate, br',
				'Accept-Language': 'en-US,en;q=0.6',
				'Content-Length': '70',
				'Content-Type': 'application/json',
				Origin: 'https://reserva-intranet.utec.edu.pe',
				Referer: 'https://reserva-intranet.utec.edu.pe/reserva/aulalibre',
				'Sec-Ch-Ua': '"Brave";v="119", "Chromium";v="119", "Not?A_Brand";v="24"',
				'Sec-Ch-Ua-Mobile': '?0',
				'Sec-Ch-Ua-Platform': 'Windows',
				'Sec-Fetch-Dest': 'empty',
				'Sec-Fetch-Mode': 'cors',
				'Sec-Fetch-Site': 'same-origin',
				'Sec-Gpc': '1',
				'User-Agent':
					'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
			}
		});

		if (!response.ok) {
			console.log(response);
			return new Response(JSON.stringify({ error: "UTEC API doesn't love you" }), {
				status: 404
			});
		}

		let data = await response.json();

		console.log(data);

		/** @type {RawEvent[]} */
		const raw_events = data.content;

		let existing_events_page = await xata.db.event
			.select(['*', 'course.*', 'host.*', 'classroom.*'])
			.filter({
				$all: [
					{
						'classroom.id': classroom.id
					},
					{
						start: {
							$ge: todayMinus5
						}
					},
					{
						end: {
							$le: todayPlus19
						}
					}
				]
			})
			.getPaginated({
				pagination: {
					size: 200
				}
			});

		let existing_events = [...existing_events_page.records];
		// in each iteration, we'll remove the event from the array if its in the UTEC API response

		let events_to_create = await Promise.all(
			raw_events.map(async ({ title, start, end }) => {
				let event_start = parseDatetime(start);
				let event_end = parseDatetime(end);
				let classroom_id = classroom.id;

				let existing_event = existing_events.find(
					(e) =>
						e.start?.toISOString() === event_start.toISOString() &&
						e.end?.toISOString() === event_end.toISOString()
				);

				if (!!existing_event) {
					// remove from existing events array
					existing_events = existing_events.filter((e) => e.id !== existing_event?.id);
					return null;
				}

				/** @type {string | undefined} */
				let event_host = undefined;

				/** @type {string | undefined} */
				let event_course = undefined;

				/** @type {string | undefined} */
				let event_name = undefined;

				if (title.includes('-') || title.includes(':')) {
					/** @type {string | undefined} */
					let host_name = undefined;

					/** @type {string | undefined} */
					let course_name = undefined;

					/** @type {string | undefined} */
					let course_code = undefined;

					if (title.includes('Docente\t')) {
						host_name = title.split('Docente\t')[1];

						let parts = title.split('-');

						course_code = parts[0].trim();
						course_name = parts[1].trim();
					} else if (title.startsWith(':')) {
						let parts = title.split('-');
						if (parts.length > 1) {
							host_name = parts[parts.length - 1].trim();
							event_name = parts.slice(0, -1).join(' ').replace(':', '').trim();
						} else {
							event_name = title.replace(':', '').trim();
						}
					}

					if (host_name) {
						event_host = await getHostID(host_name);
					}

					if (course_name && course_code) {
						event_course = await getCourseID(course_code, course_name);
					}
				} else {
					event_name = title;
				}

				return {
					start: event_start,
					end: event_end,
					classroom: classroom_id,
					name: event_name,
					course: event_course,
					host: event_host
				};
			})
		);

		// @ts-ignore
		let created_events = await xata.db.event.create(events_to_create.filter((e) => e !== null));

		// delete events that don't exist anymore
		await xata.db.event.delete(existing_events.map((e) => e.id));

		return new Response(
			JSON.stringify({
				// @ts-ignore
				created: created_events.length,
				deleted: existing_events.length
			}),
			{
				status: 200
			}
		);
	} catch (e) {
		console.log(e);
		return new Response(JSON.stringify(e), {
			status: 500
		});
	}
}

/**
 * @param {string} name
 */

async function getHostID(name) {
	let existing_host = await xata.db.host.filter({ name }).getFirst();
	if (existing_host) {
		return existing_host.id;
	} else {
		try {
			let created_host = await xata.db.host.create({
				name
			});
			return created_host.id;
		} catch (e) {
			return getHostID(name);
		}
	}
}

/**
 * @param {string} code
 * @param {string} name
 */
async function getCourseID(code, name) {
	let existing_course = await xata.db.course.filter({ code }).getFirst();
	if (existing_course) {
		return existing_course.id;
	} else {
		try {
			let created_course = await xata.db.course.create({
				code,
				name
			});
			return created_course.id;
		} catch (e) {
			return getCourseID(code, name);
		}
	}
}
