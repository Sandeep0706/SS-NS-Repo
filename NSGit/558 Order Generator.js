/**
 *@NApiVersion 2.1
 *@NScriptType UserEventScript
 */


define(['N/record', 'N/search', 'N/email', 'N/runtime'],
	// Add the callback function.
	function (record, search, email, runtime) {
		function afterSubmit(context) {
			try {
				var logJson = {};
				var ERROR_EXISTS = false;
				var ERROR_MESSAGE = '';
				var staticRecord = context.newRecord;

				var status = staticRecord.getValue('orderstatus');
				logJson.status = status;
				var PENDING_FULFILLMENT = 'B';
				if (status == PENDING_FULFILLMENT) {
					//when order is EDI Ticket 703
					var customerIsEdi = checkIfCustomerIsEdi(staticRecord);
					logJson.customerIsEdi = customerIsEdi;
					if (customerIsEdi) {
						processEdiOrder(staticRecord, logJson, ERROR_EXISTS, ERROR_MESSAGE);
					}
					//Ticket 558 Order Generator
					else {
						processNonEdiOrder(staticRecord, logJson, ERROR_EXISTS, ERROR_MESSAGE);
					}//ELSE Condition not EDI Order
				}//pending fulfillment
				log.debug("salesorder:" + staticRecord.id, logJson);
			} catch (error) {
				log.error('558 OG afterSubmit script error', error.toString());
			}
			if (ERROR_EXISTS) {
				var prepend = `Your Sales Order ${docNo} was created/edited successfully. However, there was an error generating WO/PO for some lines. <br>Please notify Michelle Rabot or the NetSuite team.`;
				throw prepend + ERROR_MESSAGE;
			}
		}

		function processNonEdiOrder(staticRecord, logJson, ERROR_EXISTS, ERROR_MESSAGE) {
			var recId = staticRecord.id;
			var docNo = search.lookupFields({ type: staticRecord.type, id: recId, columns: ['tranid'] }).tranid;
			var subsidiary = staticRecord.getValue('subsidiary');
			var customer = staticRecord.getValue('entity');
			var customerFields = search.lookupFields({ type: 'customer', id: customer, columns: ['custentity_main_customer'] });
			var main_customer = customerFields.custentity_main_customer[0].value;
			var main_customerText = customerFields.custentity_main_customer[0].text;
			logJson.salesorder = recId;
			logJson.subsidiary = subsidiary;
			logJson.customer = main_customer;

			//use main customer to find custom records
			var itemJson = {
				item: [], bom: [], bomtext: [], recType: []
			};

			var objFilters = [];
			objFilters.push(search.createFilter({ name: "custrecord_558_main_customer", operator: "anyof", values: main_customer }));
			var searchObj = search.load({ id: 'customsearch_558_specific_item' });
			searchObj.filters = searchObj.filters.concat(objFilters);

			var searchResultSet = searchObj.run();
			var searchResultRange = searchResultSet.getRange({ start: 0, end: 1000 });
			var searchLength = searchResultRange.length;
			logJson.searchLength = searchLength;

			if (searchLength > 0) {
				var dynamicRecord = record.load({ type: staticRecord.type, id: staticRecord.id, isDynamic: true });
				//loop through search results to create a local item object to use as a lookup
				for (var i = 0; i < searchLength; i++) {
					var assemblyItem = searchResultRange[i].getValue("custrecord_558_so_item");
					var item_bom = searchResultRange[i].getValue("custrecord_558_wo_bom");
					var item_bomText = searchResultRange[i].getText("custrecord_558_wo_bom");
					var recType = searchResultRange[i].getValue("custrecord_558_link_type");
					log.debug('assemblyItem :: ' + assemblyItem, 'item_bom :: ' + item_bom);

					itemJson.item.push(assemblyItem);
					itemJson.bom.push(item_bom);
					itemJson.bomtext.push(item_bomText);
					itemJson.recType.push(recType);
				}

				logJson.itemJson = itemJson;
				//	soid=2082468&soline=47&specord=T&entity=216048&assemblyitem=3671&quantity=50&location=2
				var lineCount = dynamicRecord.getLineCount('item');
				for (var j = 0; j < lineCount; j++) {
					//loop through orderlines to find items from item lookup
					var SPECIAL_WORK_ORDER = 1;
					var soLine = dynamicRecord.getSublistValue({ sublistId: 'item', fieldId: 'line', line: j });
					var assemblyItem = dynamicRecord.getSublistValue({ sublistId: 'item', fieldId: 'item', line: j });
					var catalogNumber = search.lookupFields({ type: 'item', id: assemblyItem, columns: ['itemid'] }).itemid;//dynamicRecord.getSublistText({ sublistId: 'item', fieldId: 'item', line: j });
					var lineNotLinked = dynamicRecord.getSublistValue({ sublistId: 'item', fieldId: 'linked', line: j }) != 'T';
					logJson.lineNotLinked = lineNotLinked;
					var key = itemJson.item.indexOf(assemblyItem);
					if (key !== -1 && lineNotLinked) {
						var itemQty = dynamicRecord.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: j });
						var recType = itemJson.recType[key];
						logJson.recType = recType;
						if (recType == SPECIAL_WORK_ORDER) {
							log.debug('key :: ' + key, 'soLine :: ' + soLine);
							logJson.Line = soLine;
							logJson.item = assemblyItem;
							logJson.itemQty = itemQty;
							log.debug('assemblyItem :: ' + assemblyItem, 'itemQty :: ' + itemQty);
							try {
								var bom = itemJson.bom[key];
								logJson.bom = bom;
								var bomtext = itemJson.bomtext[key];
								logJson.bomtext = bomtext;

								woFields = {
									edi: false,
									subsidiary: subsidiary,
									assemblyItem: assemblyItem,
									recId: recId,
									soLine: soLine,
									customer: customer,
									itemQty: itemQty,
									bom: bom,
								}
								var woRecId = createWorkOrder(woFields);
								if (woRecId) {
									var woNumber = search.lookupFields({ type: 'workorder', id: woRecId, columns: ['tranid'] }).tranid;
									var createdBy = dynamicRecord.getValue('custbody_created_by');
									var name = runtime.getCurrentUser().name;

									woFields.woNumber = woNumber,
										woFields.createdBy = createdBy,
										woFields.name = name,
										woFields.docNo = docNo,
										woFields.woRecId = woRecId,
										woFields.main_customer = main_customer,
										woFields.main_customerText = main_customerText,
										woFields.bomtext = bomtext,


										logJson.woFields = woFields;
									sendEmailNotification(woFields);
								}
							} catch (error) {
								log.error('processNonEdiOrder wo creation', error.toString());
								ERROR_EXISTS = true;
								ERROR_MESSAGE += `Failed to create WO/PO for ${catalogNumber} on line ${j + 1} for the following reason: ${error.message} <br>`
							}//catch
						}//SPECIAL_WORK_ORDER
					}//key
				}//loop line items
			}//search length
		}
		/**
		* Returns a string I made up of the name of the Customer, from a lookup of EDI confirmed clients
		* @param {string} customerId Record.getValue('entity')
		* @returns {string}
		*/
		function checkIfCustomerIsEdi(staticRecord) {
			var SPS_COMMERCE = "859";
			var createdByEDI = staticRecord.getValue('custbody_created_by') == SPS_COMMERCE;
			var customerId = staticRecord.getValue('entity');
			var ediCustomerList = {
				4852: "FisherScientific"
				, 6351: "VWR"
				, 4979: "GSS"
				//eventually Quartzy who is perpetually in Testing mode...
			};
			var customerName = ediCustomerList[customerId] || 'CUSTOMER IS NOT EDI';
			var output = createdByEDI && customerName != "CUSTOMER IS NOT EDI";
			return output;
		}
		function processEdiOrder(staticRecord, logJson, ERROR_EXISTS, ERROR_MESSAGE) {
			var recId = staticRecord.id;
			var docNo = search.lookupFields({ type: staticRecord.type, id: recId, columns: ['tranid'] }).tranid;
			var subsidiary = staticRecord.getValue('subsidiary');
			var customer = staticRecord.getValue('entity');
			var customerFields = search.lookupFields({ type: 'customer', id: customer, columns: ['custentity_main_customer'] });
			var main_customer = customerFields.custentity_main_customer[0].value;
			var main_customerText = customerFields.custentity_main_customer[0].text;
			var lineCount = staticRecord.getLineCount('item');
			for (var j = 0; j < lineCount; j++) {
				//loop through orderlines to find items from item lookup
				var soLine = staticRecord.getSublistValue({ sublistId: 'item', fieldId: 'line', line: j });
				var isMTO = staticRecord.getSublistValue({ sublistId: 'item', fieldId: 'custcol_is_mto', line: j });
				var assemblyItem = staticRecord.getSublistValue({ sublistId: 'item', fieldId: 'item', line: j });
				var catalogNumber = search.lookupFields({ type: 'item', id: assemblyItem, columns: ['itemid'] }).itemid;//staticRecord.getSublistText({ sublistId: 'item', fieldId: 'item', line: j });
				var lineNotLinked = staticRecord.getSublistValue({ sublistId: 'item', fieldId: 'linked', line: j }) != 'T';
				logJson.lineNotLinked = lineNotLinked;
				logJson.isMTO = isMTO;
				if (isMTO && lineNotLinked) {
					var itemQty = staticRecord.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: j });
					logJson.Line = soLine;
					logJson.item = assemblyItem;
					logJson.itemQty = itemQty;
					try {
						woFields = {
							edi: true,
							bom: null,
							subsidiary: subsidiary,
							assemblyItem: assemblyItem,
							recId: recId,
							soLine: soLine,
							customer: customer,
							itemQty: itemQty,
							bomtext: "EDI Order"
						}
						logJson.woFields = woFields;
						var woRecId = createWorkOrder(woFields);
						if (woRecId) {
							var woNumber = search.lookupFields({ type: 'workorder', id: woRecId, columns: ['tranid'] }).tranid;
							var createdBy = staticRecord.getValue('custbody_created_by');
							var name = runtime.getCurrentUser().name;

							woFields.woNumber = woNumber,
								woFields.createdBy = createdBy,
								woFields.name = name,
								woFields.docNo = docNo,
								woFields.woRecId = woRecId,
								woFields.main_customer = main_customer,
								woFields.main_customerText = main_customerText,
								woFields.bomtext = 'EDI',

								logJson.woFields = woFields;
							sendEmailNotification(woFields);
						}
					} catch (error) {
						log.error('processEdiOrder wo creation', error.toString());
						ERROR_EXISTS = true;
						ERROR_MESSAGE += `Failed to create WO/PO for ${catalogNumber} on line ${j + 1} for the following reason: ${error.message} <br>`
					}//catch
				}//isMTO
			}//loop line items
		}
		function createWorkOrder(woFields) {
			var woRecObj = record.create({
				type: record.Type.WORK_ORDER,
				//	isDynamic: true,
				defaultValues: {
					subsidiary: woFields.subsidiary,
					assemblyitem: woFields.assemblyItem
				}
			});
			if (!woFields.edi) {
				woRecObj.setValue('billofmaterials', woFields.bom);
			}
			woRecObj.setValue('soid', woFields.recId);
			woRecObj.setValue('soline', woFields.soLine);
			woRecObj.setValue('specord', true);
			woRecObj.setValue('entity', woFields.customer);
			woRecObj.setValue('location', 2);
			woRecObj.setValue('quantity', woFields.itemQty);
			woRecObj.setValue('custbody_created_via', 5);

			var woRecId = woRecObj.save();
			log.audit('salesorder:' + woFields.recId, 'workorder:' + woRecId);
			return woRecId;
		}

		function sendEmailNotification(woFields) {
			var NETSUITE_REQUESTS_EMPLOYEE = 151099; //'netsuiterequests@zymoresearch.com';
			var MICHELLE_RABOT = 3328;
			var VERONICA_ARROYO = 10772;
			var FABIOLA_HERNANDEZ = 3442;
			var cc = [];
			if (woFields.createdBy) {
				cc.push(woFields.createdBy);
			}
			var emailRecipients = [MICHELLE_RABOT, VERONICA_ARROYO, FABIOLA_HERNANDEZ];
			var emailSubject = ''
			if (woFields.edi) {
				emailSubject = `EDI - Make to Order WO ${woFields.woNumber}`;
			}
			else {
				emailSubject = `Make to Order WO ${woFields.woNumber}`;
			}
			var emailMessage = '';
			emailMessage += '<html>';
			emailMessage += '<body>';
			emailMessage += '<table style="border-collapse: collapse; width: 100%; height: 140px;" border="1">';
			emailMessage += '<tbody>';
			emailMessage += '<tr style = "height: 20px;" >';
			emailMessage += '<td style="width: 30.2245%; height: 20px;" height="20">WO Created By</td>';
			emailMessage += `<td style= width: 69.4301%; height: 20px;">${woFields.name}</td>`;
			emailMessage += '</tr >';
			emailMessage += '<tr style="height: 20px;">';
			emailMessage += '<td style="width: 30.2245%; height: 20px;" height="20">SO#</td>';
			emailMessage += `<td style="width: 69.4301%; height: 20px;"><a href="https://1247584.app.netsuite.com/app/accounting/transactions/salesord.nl?id=${woFields.recId}&whence=">${woFields.docNo}</a></td>`;
			emailMessage += '</tr>';
			emailMessage += '<tr style="height: 20px;">';
			emailMessage += '<td style="width: 30.2245%; height: 20px;" height="20">WO#</td>';
			emailMessage += `<td style="width: 69.4301%; height: 20px;"><a href="https://1247584.app.netsuite.com/app/accounting/transactions/workord.nl?id=${woFields.woRecId}&whence=">${woFields.woNumber}</a></td>`;
			emailMessage += '</tr>';
			emailMessage += '<tr style="height: 20px;">';
			emailMessage += '<td style="width: 30.2245%; height: 20px;" height="20">Customer</td>';
			emailMessage += `<td style="width: 69.4301%; height: 20px;"><a href="https://1247584.app.netsuite.com/app/common/entity/custjob.nl?id=${woFields.main_customer}&whence=">${woFields.main_customerText}</a></td>`;
			emailMessage += '</tr>';
			emailMessage += '<tr style="height: 20px;">';
			emailMessage += '<td style="width: 30.2245%; height: 20px;" height="20">BOM</td>';
			emailMessage += `<td style="width: 69.4301%; height: 20px;">${woFields.bomtext}</td>`;
			emailMessage += '</tr>';
			emailMessage += '<tr style="height: 20px;">';
			emailMessage += '<td style="width: 30.2245%; height: 20px;" height="20">Quantity</td>';
			emailMessage += `<td style="width: 69.4301%; height: 20px;">${woFields.itemQty}</td>`;
			emailMessage += '</tr>';
			emailMessage += '</tbody >';
			emailMessage += '</table >';
			emailMessage += '</body>';
			emailMessage += '</html>';

			email.send({
				author: NETSUITE_REQUESTS_EMPLOYEE,
				recipients: emailRecipients,
				cc: cc,
				subject: emailSubject,
				body: emailMessage,
				relatedRecords: { transactionId: woFields.woRecId }
			});
		}
		return {
			afterSubmit: afterSubmit
		};
	})